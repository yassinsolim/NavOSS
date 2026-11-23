#if os(Android)
  import CNavOSSJNI
  import NavOSSNavigationCore

  // JNI entry points of `org.navoss.navigation.core.NavOSSCore`, over `NavOSSCoreEngine`. The
  // contract (functions, callbacks, threads, errors, strings) is docs/architecture/android-core.md.

  public typealias Env = UnsafeMutablePointer<JNIEnv?>
  public typealias VM = UnsafeMutablePointer<JavaVM?>

  private let exceptionClassName = "org/navoss/navigation/core/NavOSSCoreException"

  // MARK: Strings (UTF-16 both ways, so text outside the BMP survives)

  private func swiftString(_ env: Env, _ value: jstring?) -> String? {
    guard let value else { return nil }
    let jni = env.pointee!.pointee
    let length = Int(jni.GetStringLength(env, value))
    guard let chars = jni.GetStringChars(env, value, nil) else { return nil }
    defer { jni.ReleaseStringChars(env, value, chars) }
    return String(decoding: UnsafeBufferPointer(start: chars, count: length), as: UTF16.self)
  }

  private func javaString(_ env: Env, _ value: String) -> jstring? {
    let units = Array(value.utf16)
    return units.withUnsafeBufferPointer { buffer in
      env.pointee!.pointee.NewString(env, buffer.baseAddress, jsize(buffer.count))
    }
  }

  /// Raises `NavOSSCoreException(code, message)` in the calling Java thread.
  private func raise(_ env: Env, _ error: NavOSSCoreError) {
    let jni = env.pointee!.pointee
    guard let type = jni.FindClass(env, exceptionClassName) else { return }
    defer { jni.DeleteLocalRef(env, type) }
    guard
      let constructor = jni.GetMethodID(
        env, type, "<init>", "(Ljava/lang/String;Ljava/lang/String;)V")
    else { return }
    let code = javaString(env, error.code)
    let message = javaString(env, error.message)
    var arguments = [jvalue(l: code), jvalue(l: message)]
    if let exception = jni.NewObjectA(env, type, constructor, &arguments) {
      _ = jni.Throw(env, exception)
      jni.DeleteLocalRef(env, exception)
    }
    jni.DeleteLocalRef(env, code)
    jni.DeleteLocalRef(env, message)
  }

  // MARK: Host

  /// The Kotlin `NavOSSCore.Host`, called from any thread.
  private final class JNIHost: NavOSSCoreHost {
    private let vm: VM
    private let host: jobject
    private let onStateChanged: jmethodID
    private let speakMethod: jmethodID
    private let cancelSpeechMethod: jmethodID
    private let needsLocationUpdatesMethod: jmethodID
    private let reconcileMethod: jmethodID
    private let startClockMethod: jmethodID
    private let stopClockMethod: jmethodID
    private let httpRequestMethod: jmethodID
    private let cancelHttpRequestMethod: jmethodID
    private let storageReadMethod: jmethodID
    private let storageWriteMethod: jmethodID
    private let nowMsMethod: jmethodID

    init?(env: Env, host: jobject) {
      let jni = env.pointee!.pointee
      var vm: VM?
      guard jni.GetJavaVM(env, &vm) == JNI_OK, let vm, let type = jni.GetObjectClass(env, host)
      else { return nil }
      defer { jni.DeleteLocalRef(env, type) }
      func method(_ name: String, _ signature: String) -> jmethodID? {
        jni.GetMethodID(env, type, name, signature)
      }
      guard let onStateChanged = method("onStateChanged", "(Ljava/lang/String;)V"),
        let speak = method("speak", "(Ljava/lang/String;Ljava/lang/String;J)V"),
        let cancelSpeech = method("cancelSpeech", "(J)V"),
        let needsLocationUpdates = method("needsLocationUpdates", "()V"),
        let reconcile = method("reconcileLocationUpdates", "(JZ)V"),
        let startClock = method("startClock", "(J)V"),
        let stopClock = method("stopClock", "(J)V"),
        let httpRequest = method("httpRequest", "(JLjava/lang/String;)V"),
        let cancelHttpRequest = method("cancelHttpRequest", "(J)V"),
        let storageRead = method("storageRead", "(Ljava/lang/String;)Ljava/lang/String;"),
        let storageWrite = method("storageWrite", "(Ljava/lang/String;Ljava/lang/String;)V"),
        let nowMs = method("nowMs", "()D"),
        let global = jni.NewGlobalRef(env, host)
      else {
        return nil
      }
      self.vm = vm
      self.host = global
      self.onStateChanged = onStateChanged
      speakMethod = speak
      cancelSpeechMethod = cancelSpeech
      needsLocationUpdatesMethod = needsLocationUpdates
      reconcileMethod = reconcile
      startClockMethod = startClock
      stopClockMethod = stopClock
      httpRequestMethod = httpRequest
      cancelHttpRequestMethod = cancelHttpRequest
      storageReadMethod = storageRead
      storageWriteMethod = storageWrite
      nowMsMethod = nowMs
    }

    deinit {
      withEnv { env in env.pointee!.pointee.DeleteGlobalRef(env, host) }
    }

    /// Runs `body` with this thread's `JNIEnv`, attaching a non-Java thread (a Swift concurrency
    /// worker) for the call only. A Java exception the callback throws is logged and cleared:
    /// it must not stay pending under the engine.
    @discardableResult
    private func withEnv<T>(_ body: (Env) -> T?) -> T? {
      let invoke = vm.pointee!.pointee
      var raw: UnsafeMutableRawPointer?
      var attached = false
      if invoke.GetEnv(vm, &raw, jint(JNI_VERSION_1_6)) != JNI_OK {
        var attachedEnv: Env?
        guard invoke.AttachCurrentThread(vm, &attachedEnv, nil) == JNI_OK, let attachedEnv
        else { return nil }
        raw = UnsafeMutableRawPointer(attachedEnv)
        attached = true
      }
      let env = raw!.assumingMemoryBound(to: JNIEnv?.self)
      let jni = env.pointee!.pointee
      _ = jni.PushLocalFrame(env, 8)
      let result = body(env)
      if jni.ExceptionCheck(env) != 0 {
        jni.ExceptionDescribe(env)
        jni.ExceptionClear(env)
      }
      _ = jni.PopLocalFrame(env, nil)
      if attached { _ = invoke.DetachCurrentThread(vm) }
      return result
    }

    private func call(_ method: jmethodID, _ arguments: [jvalue]) {
      withEnv { env -> Void? in
        var arguments = arguments
        env.pointee!.pointee.CallVoidMethodA(env, host, method, &arguments)
        return ()
      }
    }

    func stateChanged(_ snapshotJSON: String) {
      withEnv { env -> Void? in
        var arguments = [jvalue(l: javaString(env, snapshotJSON))]
        env.pointee!.pointee.CallVoidMethodA(env, host, onStateChanged, &arguments)
        return ()
      }
    }

    func speak(text: String, kind: String, generation: UInt64) {
      withEnv { env -> Void? in
        var arguments = [
          jvalue(l: javaString(env, text)), jvalue(l: javaString(env, kind)),
          jvalue(j: jlong(bitPattern: generation)),
        ]
        env.pointee!.pointee.CallVoidMethodA(env, host, speakMethod, &arguments)
        return ()
      }
    }

    func cancelSpeech(generation: UInt64) {
      call(cancelSpeechMethod, [jvalue(j: jlong(bitPattern: generation))])
    }

    func needsLocationUpdates() {
      call(needsLocationUpdatesMethod, [])
    }

    func reconcileLocationUpdates(generation: UInt64, shouldTrack: Bool) {
      call(
        reconcileMethod,
        [jvalue(j: jlong(bitPattern: generation)), jvalue(z: jboolean(shouldTrack ? JNI_TRUE : JNI_FALSE))])
    }

    func startClock(generation: UInt64) {
      call(startClockMethod, [jvalue(j: jlong(bitPattern: generation))])
    }

    func stopClock(generation: UInt64) {
      call(stopClockMethod, [jvalue(j: jlong(bitPattern: generation))])
    }

    func httpRequest(id: Int64, json: String) {
      withEnv { env -> Void? in
        var arguments = [jvalue(j: jlong(id)), jvalue(l: javaString(env, json))]
        env.pointee!.pointee.CallVoidMethodA(env, host, httpRequestMethod, &arguments)
        return ()
      }
    }

    func cancelHTTPRequest(id: Int64) {
      call(cancelHttpRequestMethod, [jvalue(j: jlong(id))])
    }

    func storageRead(key: String) -> String? {
      withEnv { env -> String? in
        var arguments = [jvalue(l: javaString(env, key))]
        let jni = env.pointee!.pointee
        let value = jni.CallObjectMethodA(env, host, storageReadMethod, &arguments)
        guard jni.ExceptionCheck(env) == 0 else { return nil }
        return swiftString(env, value)
      }
    }

    func storageWrite(key: String, value: String?) {
      withEnv { env -> Void? in
        var arguments = [
          jvalue(l: javaString(env, key)), jvalue(l: value.flatMap { javaString(env, $0) }),
        ]
        env.pointee!.pointee.CallVoidMethodA(env, host, storageWriteMethod, &arguments)
        return ()
      }
    }

    func nowMs() -> Double {
      withEnv { env -> Double? in
        let jni = env.pointee!.pointee
        let value = jni.CallDoubleMethodA(env, host, nowMsMethod, nil)
        return jni.ExceptionCheck(env) == 0 ? value : nil
      } ?? 0
    }
  }

  // MARK: Handle

  private final class NativeEngine {
    let engine: NavOSSCoreEngine
    let host: JNIHost

    init(engine: NavOSSCoreEngine, host: JNIHost) {
      self.engine = engine
      self.host = host
    }
  }

  private func engine(_ env: Env, _ handle: jlong) -> NavOSSCoreEngine? {
    guard handle != 0, let pointer = UnsafeRawPointer(bitPattern: Int(handle)) else {
      raise(env, NavOSSCoreError(code: "closed", message: "The engine was closed"))
      return nil
    }
    return Unmanaged<NativeEngine>.fromOpaque(pointer).takeUnretainedValue().engine
  }

  /// Runs `body` on the engine and returns its string, or raises its error and returns `nil`.
  private func string(_ env: Env, _ handle: jlong, _ body: (NavOSSCoreEngine) throws -> String)
    -> jstring?
  {
    guard let engine = engine(env, handle) else { return nil }
    do {
      return javaString(env, try body(engine))
    } catch let error as NavOSSCoreError {
      raise(env, error)
    } catch {
      raise(env, NavOSSCoreError(code: "internal", message: "\(error)"))
    }
    return nil
  }

  private func argument(_ env: Env, _ value: jstring?) throws -> String {
    guard let string = swiftString(env, value) else {
      throw NavOSSCoreError(code: "invalid-argument", message: "Missing string argument")
    }
    return string
  }

  private func unit(_ env: Env, _ handle: jlong, _ body: (NavOSSCoreEngine) throws -> Void) {
    _ = string(env, handle) { engine in
      try body(engine)
      return ""
    }
  }

  // MARK: Entry points

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeAbiVersion")
  public func nativeAbiVersion(_ env: Env, _: jclass) -> jint {
    navOSSCoreABIVersion
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeContractVersion")
  public func nativeContractVersion(_ env: Env, _: jclass) -> jint {
    navOSSCoreContractVersion
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeCreate")
  public func nativeCreate(_ env: Env, _: jclass, _ config: jstring?, _ host: jobject?) -> jlong {
    guard let host, let bridge = JNIHost(env: env, host: host) else {
      raise(env, NavOSSCoreError(code: "invalid-argument", message: "Host is missing a method"))
      return 0
    }
    do {
      let engine = try NavOSSCoreEngine(configJSON: try argument(env, config), host: bridge)
      let native = NativeEngine(engine: engine, host: bridge)
      return jlong(Int(bitPattern: Unmanaged.passRetained(native).toOpaque()))
    } catch let error as NavOSSCoreError {
      raise(env, error)
    } catch {
      raise(env, NavOSSCoreError(code: "internal", message: "\(error)"))
    }
    return 0
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeDestroy")
  public func nativeDestroy(_ env: Env, _: jclass, _ handle: jlong) {
    guard handle != 0, let pointer = UnsafeRawPointer(bitPattern: Int(handle)) else { return }
    let native = Unmanaged<NativeEngine>.fromOpaque(pointer)
    native.takeUnretainedValue().engine.close()
    native.release()
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeResumePersistedTrip")
  public func nativeResumePersistedTrip(_ env: Env, _: jclass, _ handle: jlong) -> jstring? {
    string(env, handle) { $0.resumePersistedTrip() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetRoute")
  public func nativeSetRoute(_ env: Env, _: jclass, _ handle: jlong, _ trip: jstring?) -> jstring? {
    string(env, handle) { try $0.setRoute(try argument(env, trip)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeUpdateLocation")
  public func nativeUpdateLocation(
    _ env: Env, _: jclass, _ handle: jlong, _ sample: jstring?
  ) -> jstring? {
    string(env, handle) { try $0.updateLocation(try argument(env, sample)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeClearRoute")
  public func nativeClearRoute(_ env: Env, _: jclass, _ handle: jlong) -> jstring? {
    string(env, handle) { $0.clearRoute() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeGetSnapshot")
  public func nativeGetSnapshot(_ env: Env, _: jclass, _ handle: jlong) -> jstring? {
    string(env, handle) { $0.snapshot() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeAcceptRerouteProposal")
  public func nativeAcceptRerouteProposal(
    _ env: Env, _: jclass, _ handle: jlong, _ id: jstring?
  ) -> jboolean {
    var accepted = false
    unit(env, handle) { accepted = $0.acceptRerouteProposal(id: try argument(env, id)) }
    return jboolean(accepted ? JNI_TRUE : JNI_FALSE)
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeDeclineRerouteProposal")
  public func nativeDeclineRerouteProposal(
    _ env: Env, _: jclass, _ handle: jlong, _ id: jstring?
  ) -> jboolean {
    var declined = false
    unit(env, handle) { declined = $0.declineRerouteProposal(id: try argument(env, id)) }
    return jboolean(declined ? JNI_TRUE : JNI_FALSE)
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetRerouteMode")
  public func nativeSetRerouteMode(_ env: Env, _: jclass, _ handle: jlong, _ mode: jstring?) {
    unit(env, handle) { try $0.setRerouteMode(try argument(env, mode)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetAudioMode")
  public func nativeSetAudioMode(_ env: Env, _: jclass, _ handle: jlong, _ mode: jstring?) {
    unit(env, handle) { try $0.setAudioMode(try argument(env, mode)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetSpeedingWarning")
  public func nativeSetSpeedingWarning(
    _ env: Env, _: jclass, _ handle: jlong, _ toleranceKph: jint, _ audible: jboolean
  ) {
    unit(env, handle) {
      $0.setSpeedingWarning(toleranceKph: Int(toleranceKph), audible: audible != 0)
    }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetAnnounceRoadReports")
  public func nativeSetAnnounceRoadReports(
    _ env: Env, _: jclass, _ handle: jlong, _ enabled: jboolean
  ) {
    unit(env, handle) { $0.setAnnounceRoadReports(enabled != 0) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeGetPreferences")
  public func nativeGetPreferences(_ env: Env, _: jclass, _ handle: jlong) -> jstring? {
    string(env, handle) { $0.preferences() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeClockTick")
  public func nativeClockTick(_ env: Env, _: jclass, _ handle: jlong) {
    unit(env, handle) { $0.clockTick() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeIsCurrentGeneration")
  public func nativeIsCurrentGeneration(
    _ env: Env, _: jclass, _ handle: jlong, _ generation: jlong
  ) -> jboolean {
    var current = false
    unit(env, handle) { current = $0.isCurrentGeneration(UInt64(bitPattern: generation)) }
    return jboolean(current ? JNI_TRUE : JNI_FALSE)
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeCompleteHttpRequest")
  public func nativeCompleteHttpRequest(
    _ env: Env, _: jclass, _ handle: jlong, _ id: jlong, _ response: jstring?
  ) {
    unit(env, handle) {
      // A missing body is the host failing to answer: the request failed.
      $0.completeHTTPRequest(
        id: Int64(id), responseJSON: swiftString(env, response) ?? #"{"error":"unreachable"}"#)
    }
  }
#endif
