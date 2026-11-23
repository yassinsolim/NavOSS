#if os(Android)
  import CNavOSSJNI
  import Foundation
  import NavOSSNavigationCore

  // JNI entry points of `org.navoss.navigation.core.NavOSSCore`, over `NavOSSCoreEngine`. The
  // contract (functions, callbacks, threads, errors, strings) is docs/architecture/android-core.md.

  public typealias Env = UnsafeMutablePointer<JNIEnv?>
  public typealias VM = UnsafeMutablePointer<JavaVM?>

  private let exceptionClassName = "org/navoss/navigation/core/NavOSSCoreException"

  // Failures. A JNI call that can fail leaves a Java exception pending (`NewString`,
  // `GetStringChars` and `PushLocalFrame` an `OutOfMemoryError`), and with one pending almost no
  // JNI call may be made. So every such call is checked, and the path that failed makes no
  // further JNI call except the ones allowed then (`ExceptionCheck`, `ExceptionClear`,
  // `DeleteLocalRef`, `ReleaseStringChars`, `PopLocalFrame`, `DeleteGlobalRef`):
  // - an entry point called from Java returns its zero value and leaves the exception pending,
  //   so the caller sees it;
  // - a host callback clears it (nothing above it could handle it, and the engine carries on
  //   making callbacks on this thread) and logs the callback's name, nothing else.

  // MARK: Strings (UTF-16 both ways, so text outside the BMP survives)

  /// `nil` for a `null` reference, or with an `OutOfMemoryError` pending.
  private func swiftString(_ env: Env, _ value: jstring?) -> String? {
    guard let value else { return nil }
    let jni = env.pointee!.pointee
    let length = Int(jni.GetStringLength(env, value))
    guard let chars = jni.GetStringChars(env, value, nil) else { return nil }
    defer { jni.ReleaseStringChars(env, value, chars) }
    return String(decoding: UnsafeBufferPointer(start: chars, count: length), as: UTF16.self)
  }

  /// `nil` with an `OutOfMemoryError` pending.
  private func javaString(_ env: Env, _ value: String) -> jstring? {
    let units = Array(value.utf16)
    return units.withUnsafeBufferPointer { buffer in
      env.pointee!.pointee.NewString(env, buffer.baseAddress, jsize(buffer.count))
    }
  }

  /// Raises `NavOSSCoreException(code, message)` in the calling Java thread. If an exception
  /// is pending already, or one of the steps here fails and leaves its own, that one stands.
  private func raise(_ env: Env, _ error: NavOSSCoreError) {
    let jni = env.pointee!.pointee
    guard jni.ExceptionCheck(env) == 0 else { return }
    guard let type = jni.FindClass(env, exceptionClassName) else { return }
    defer { jni.DeleteLocalRef(env, type) }
    guard
      let constructor = jni.GetMethodID(
        env, type, "<init>", "(Ljava/lang/String;Ljava/lang/String;)V")
    else { return }
    guard let code = javaString(env, error.code) else { return }
    defer { jni.DeleteLocalRef(env, code) }
    guard let message = javaString(env, error.message) else { return }
    defer { jni.DeleteLocalRef(env, message) }
    var arguments = [jvalue(l: code), jvalue(l: message)]
    guard let exception = jni.NewObjectA(env, type, constructor, &arguments) else { return }
    _ = jni.Throw(env, exception)
    jni.DeleteLocalRef(env, exception)
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
      // DeleteGlobalRef is legal with an exception pending, and one may be: `nativeCreate`
      // raises before a host whose engine failed to start is released. So no `withEnv`, which
      // would clear it.
      let invoke = vm.pointee!.pointee
      var raw: UnsafeMutableRawPointer?
      if invoke.GetEnv(vm, &raw, jint(JNI_VERSION_1_6)) == JNI_OK, let raw {
        let env = raw.assumingMemoryBound(to: JNIEnv?.self)
        env.pointee!.pointee.DeleteGlobalRef(env, host)
        return
      }
      var attachedEnv: Env?
      guard invoke.AttachCurrentThread(vm, &attachedEnv, nil) == JNI_OK, let attachedEnv else {
        return
      }
      attachedEnv.pointee!.pointee.DeleteGlobalRef(attachedEnv, host)
      _ = invoke.DetachCurrentThread(vm)
    }

    /// Runs `body` with this thread's `JNIEnv` and a local reference frame, attaching a
    /// non-Java thread (a Swift concurrency worker) for the call only. `body` returns `nil` as
    /// soon as a JNI call of its own fails. Whatever exception is pending afterwards (thrown
    /// by the host's method, or an allocation failure) is cleared, and the result is `nil`.
    @discardableResult
    private func withEnv<T>(_ callback: String, _ body: (Env) -> T?) -> T? {
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
      defer { if attached { _ = invoke.DetachCurrentThread(vm) } }
      let env = raw!.assumingMemoryBound(to: JNIEnv?.self)
      let jni = env.pointee!.pointee
      guard jni.PushLocalFrame(env, 8) == 0 else {
        // No frame was pushed; an OutOfMemoryError is pending.
        _ = Self.clearException(env, in: callback)
        return nil
      }
      let result = body(env)
      let failed = Self.clearException(env, in: callback)
      _ = jni.PopLocalFrame(env, nil)
      return failed ? nil : result
    }

    /// Clears a pending exception and says whether there was one. The log line names the
    /// callback only: the exception's message and stack, which `ExceptionDescribe` would
    /// print, can quote a snapshot, a request or a stored trip. A host that wants its own
    /// exceptions logged catches them in its callback.
    private static func clearException(_ env: Env, in callback: String) -> Bool {
      let jni = env.pointee!.pointee
      guard jni.ExceptionCheck(env) != 0 else { return false }
      jni.ExceptionClear(env)
      navoss_log_error("Host callback \(callback) failed with a Java exception; it was cleared")
      return true
    }

    private func call(_ callback: String, _ method: jmethodID, _ arguments: [jvalue]) {
      withEnv(callback) { env -> Void? in
        var arguments = arguments
        env.pointee!.pointee.CallVoidMethodA(env, host, method, &arguments)
        return ()
      }
    }

    func stateChanged(_ snapshotJSON: String) {
      withEnv("onStateChanged") { env -> Void? in
        guard let snapshot = javaString(env, snapshotJSON) else { return nil }
        var arguments = [jvalue(l: snapshot)]
        env.pointee!.pointee.CallVoidMethodA(env, host, onStateChanged, &arguments)
        return ()
      }
    }

    func speak(text: String, kind: String, generation: UInt64) {
      withEnv("speak") { env -> Void? in
        guard let text = javaString(env, text), let kind = javaString(env, kind) else {
          return nil
        }
        var arguments = [jvalue(l: text), jvalue(l: kind), jvalue(j: jlong(bitPattern: generation))]
        env.pointee!.pointee.CallVoidMethodA(env, host, speakMethod, &arguments)
        return ()
      }
    }

    func cancelSpeech(generation: UInt64) {
      call("cancelSpeech", cancelSpeechMethod, [jvalue(j: jlong(bitPattern: generation))])
    }

    func needsLocationUpdates() {
      call("needsLocationUpdates", needsLocationUpdatesMethod, [])
    }

    func reconcileLocationUpdates(generation: UInt64, shouldTrack: Bool) {
      call(
        "reconcileLocationUpdates", reconcileMethod,
        [jvalue(j: jlong(bitPattern: generation)), jvalue(z: jboolean(shouldTrack ? JNI_TRUE : JNI_FALSE))])
    }

    func startClock(generation: UInt64) {
      call("startClock", startClockMethod, [jvalue(j: jlong(bitPattern: generation))])
    }

    func stopClock(generation: UInt64) {
      call("stopClock", stopClockMethod, [jvalue(j: jlong(bitPattern: generation))])
    }

    func httpRequest(id: Int64, json: String) {
      withEnv("httpRequest") { env -> Void? in
        guard let request = javaString(env, json) else { return nil }
        var arguments = [jvalue(j: jlong(id)), jvalue(l: request)]
        env.pointee!.pointee.CallVoidMethodA(env, host, httpRequestMethod, &arguments)
        return ()
      }
    }

    func cancelHTTPRequest(id: Int64) {
      call("cancelHttpRequest", cancelHttpRequestMethod, [jvalue(j: jlong(id))])
    }

    func storageRead(key: String) -> String? {
      withEnv("storageRead") { env -> String? in
        guard let key = javaString(env, key) else { return nil }
        var arguments = [jvalue(l: key)]
        let jni = env.pointee!.pointee
        let value = jni.CallObjectMethodA(env, host, storageReadMethod, &arguments)
        guard jni.ExceptionCheck(env) == 0 else { return nil }
        return swiftString(env, value)
      }
    }

    func storageWrite(key: String, value: String?) {
      withEnv("storageWrite") { env -> Void? in
        guard let key = javaString(env, key) else { return nil }
        var stored: jstring?
        if let value {
          guard let string = javaString(env, value) else { return nil }
          stored = string
        }
        var arguments = [jvalue(l: key), jvalue(l: stored)]
        env.pointee!.pointee.CallVoidMethodA(env, host, storageWriteMethod, &arguments)
        return ()
      }
    }

    /// The system clock if the host's fails: a clock at zero would expire everything.
    func nowMs() -> Double {
      withEnv("nowMs") { env -> Double? in
        env.pointee!.pointee.CallDoubleMethodA(env, host, nowMsMethod, nil)
      } ?? Date().timeIntervalSince1970 * 1_000
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

  /// Runs `body` on the engine, or raises its error and returns `nil`.
  private func run<T>(_ env: Env, _ handle: jlong, _ body: (NavOSSCoreEngine) throws -> T) -> T? {
    guard let engine = engine(env, handle) else { return nil }
    do {
      return try body(engine)
    } catch let error as NavOSSCoreError {
      raise(env, error)
    } catch {
      // The type only: an error's description may quote what it was given.
      raise(env, NavOSSCoreError(code: "internal", message: "\(type(of: error))"))
    }
    return nil
  }

  /// `run` for a call that returns text. `nil` with an exception pending.
  private func string(_ env: Env, _ handle: jlong, _ body: (NavOSSCoreEngine) throws -> String)
    -> jstring?
  {
    guard let value = run(env, handle, body) else { return nil }
    return javaString(env, value)
  }

  private func argument(_ env: Env, _ value: jstring?) throws -> String {
    guard let string = swiftString(env, value) else {
      // `null`, or an OutOfMemoryError is pending and stands instead of this error.
      throw NavOSSCoreError(code: "invalid-argument", message: "Missing string argument")
    }
    return string
  }

  private func boolean(_ value: Bool?) -> jboolean {
    jboolean(value == true ? JNI_TRUE : JNI_FALSE)
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
      // A missing method left its NoSuchMethodError pending, and that stands.
      raise(env, NavOSSCoreError(code: "invalid-argument", message: "The host could not be bound"))
      return 0
    }
    do {
      let engine = try NavOSSCoreEngine(configJSON: try argument(env, config), host: bridge)
      let native = NativeEngine(engine: engine, host: bridge)
      return jlong(Int(bitPattern: Unmanaged.passRetained(native).toOpaque()))
    } catch let error as NavOSSCoreError {
      raise(env, error)
    } catch {
      raise(env, NavOSSCoreError(code: "internal", message: "\(type(of: error))"))
    }
    return 0
  }

  /// Cancels the host's pending requests and stops its callbacks (`NavOSSCoreEngine.close`).
  /// The handle stays valid until `nativeDestroy`.
  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeClose")
  public func nativeClose(_ env: Env, _: jclass, _ handle: jlong) {
    _ = run(env, handle) { $0.close() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeDestroy")
  public func nativeDestroy(_ env: Env, _: jclass, _ handle: jlong) {
    // Releases the handle. The Kotlin binding calls this once, after `nativeClose` and after
    // the last call that was using the handle has returned. Callbacks still running hold their
    // own references to what they use.
    guard handle != 0, let pointer = UnsafeRawPointer(bitPattern: Int(handle)) else { return }
    let native = Unmanaged<NativeEngine>.fromOpaque(pointer)
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
    boolean(run(env, handle) { $0.acceptRerouteProposal(id: try argument(env, id)) })
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeDeclineRerouteProposal")
  public func nativeDeclineRerouteProposal(
    _ env: Env, _: jclass, _ handle: jlong, _ id: jstring?
  ) -> jboolean {
    boolean(run(env, handle) { $0.declineRerouteProposal(id: try argument(env, id)) })
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetRerouteMode")
  public func nativeSetRerouteMode(_ env: Env, _: jclass, _ handle: jlong, _ mode: jstring?) {
    _ = run(env, handle) { try $0.setRerouteMode(try argument(env, mode)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetAudioMode")
  public func nativeSetAudioMode(_ env: Env, _: jclass, _ handle: jlong, _ mode: jstring?) {
    _ = run(env, handle) { try $0.setAudioMode(try argument(env, mode)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetSpeedingWarning")
  public func nativeSetSpeedingWarning(
    _ env: Env, _: jclass, _ handle: jlong, _ toleranceKph: jint, _ audible: jboolean
  ) {
    _ = run(env, handle) {
      $0.setSpeedingWarning(toleranceKph: Int(toleranceKph), audible: audible != 0)
    }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeSetAnnounceRoadReports")
  public func nativeSetAnnounceRoadReports(
    _ env: Env, _: jclass, _ handle: jlong, _ enabled: jboolean
  ) {
    _ = run(env, handle) { $0.setAnnounceRoadReports(enabled != 0) }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeGetPreferences")
  public func nativeGetPreferences(_ env: Env, _: jclass, _ handle: jlong) -> jstring? {
    string(env, handle) { $0.preferences() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeClockTick")
  public func nativeClockTick(_ env: Env, _: jclass, _ handle: jlong) {
    _ = run(env, handle) { $0.clockTick() }
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeIsCurrentGeneration")
  public func nativeIsCurrentGeneration(
    _ env: Env, _: jclass, _ handle: jlong, _ generation: jlong
  ) -> jboolean {
    boolean(run(env, handle) { $0.isCurrentGeneration(UInt64(bitPattern: generation)) })
  }

  @_cdecl("Java_org_navoss_navigation_core_NavOSSCore_nativeCompleteHttpRequest")
  public func nativeCompleteHttpRequest(
    _ env: Env, _: jclass, _ handle: jlong, _ id: jlong, _ response: jstring?
  ) {
    _ = run(env, handle) {
      // A missing body (`null`, or a string that could not be read) is the host failing to
      // answer: the request failed.
      $0.completeHTTPRequest(
        id: Int64(id), responseJSON: swiftString(env, response) ?? #"{"error":"unreachable"}"#)
    }
  }
#endif
