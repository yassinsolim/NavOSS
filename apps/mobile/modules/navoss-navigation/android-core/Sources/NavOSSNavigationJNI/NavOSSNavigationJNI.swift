#if os(Android)
  import CNavOSSJNI
  import Foundation
  import NavOSSNavigationCore

  // JNI entry points for `org.navoss.navigation.core.SwiftNavigationEngine`. Strings in and out
  // are JSON; a Swift error becomes an IllegalStateException carrying its description.

  public typealias Env = UnsafeMutablePointer<JNIEnv?>

  /// One engine and the Kotlin listener it reports to.
  private final class EngineHandle {
    let engine = NavOSSEngineFacade()
    let vm: UnsafeMutablePointer<JavaVM?>
    let listener: jobject
    let onEvent: jmethodID

    init(env: Env, listener: jobject) {
      let jni = env.pointee!.pointee
      var vm: UnsafeMutablePointer<JavaVM?>?
      _ = jni.GetJavaVM(env, &vm)
      self.vm = vm!
      self.listener = jni.NewGlobalRef(env, listener)!
      let listenerClass = jni.GetObjectClass(env, listener)
      onEvent = jni.GetMethodID(
        env, listenerClass, "onEvent", "(Ljava/lang/String;Ljava/lang/String;)V")!
      jni.DeleteLocalRef(env, listenerClass)
      engine.onEvent = { [unowned self] kind, json in self.emit(kind: kind, json: json) }
    }

    /// Calls the listener on the calling thread, attaching it to the VM when it is not a Java
    /// thread (an engine timer, for example).
    private func emit(kind: String, json: String) {
      var raw: UnsafeMutableRawPointer?
      let invoke = vm.pointee!.pointee
      var attached = false
      if invoke.GetEnv(vm, &raw, jint(JNI_VERSION_1_6)) != JNI_OK {
        var attachedEnv: Env?
        guard invoke.AttachCurrentThread(vm, &attachedEnv, nil) == JNI_OK else { return }
        raw = UnsafeMutableRawPointer(attachedEnv)
        attached = true
      }
      let env = raw!.assumingMemoryBound(to: JNIEnv?.self)
      let jni = env.pointee!.pointee
      let kindString = jni.NewStringUTF(env, kind)
      let jsonString = jni.NewStringUTF(env, json)
      var arguments = [jvalue(l: kindString), jvalue(l: jsonString)]
      jni.CallVoidMethodA(env, listener, onEvent, &arguments)
      jni.DeleteLocalRef(env, kindString)
      jni.DeleteLocalRef(env, jsonString)
      if attached { _ = invoke.DetachCurrentThread(vm) }
    }

    func release(env: Env) {
      env.pointee!.pointee.DeleteGlobalRef(env, listener)
    }
  }

  private func handle(_ value: jlong) -> EngineHandle {
    Unmanaged<EngineHandle>.fromOpaque(UnsafeRawPointer(bitPattern: Int(value))!)
      .takeUnretainedValue()
  }

  private func string(_ env: Env, _ value: jstring?) -> String {
    let jni = env.pointee!.pointee
    guard let value, let chars = jni.GetStringUTFChars(env, value, nil) else { return "" }
    defer { jni.ReleaseStringUTFChars(env, value, chars) }
    return String(cString: chars)
  }

  /// Runs `body` and returns its JSON as a Java string, or throws it into Java.
  private func call(_ env: Env, _ body: () throws -> String) -> jstring? {
    let jni = env.pointee!.pointee
    do {
      return jni.NewStringUTF(env, try body())
    } catch {
      let exception = jni.FindClass(env, "java/lang/IllegalStateException")
      _ = jni.ThrowNew(env, exception, "\(error)")
      return nil
    }
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeCreate")
  public func nativeCreate(_ env: Env, _: jclass, _ listener: jobject) -> jlong {
    jlong(Int(bitPattern: Unmanaged.passRetained(EngineHandle(env: env, listener: listener))
      .toOpaque()))
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeDestroy")
  public func nativeDestroy(_ env: Env, _: jclass, _ value: jlong) {
    let unmanaged = Unmanaged<EngineHandle>.fromOpaque(
      UnsafeRawPointer(bitPattern: Int(value))!)
    unmanaged.takeUnretainedValue().release(env: env)
    unmanaged.release()
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeSetRoute")
  public func nativeSetRoute(_ env: Env, _: jclass, _ value: jlong, _ json: jstring?) -> jstring? {
    call(env) { try handle(value).engine.setRoute(fromRoutesV2Request: string(env, json)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeUpdateLocation")
  public func nativeUpdateLocation(
    _ env: Env, _: jclass, _ value: jlong, _ json: jstring?
  ) -> jstring? {
    call(env) { try handle(value).engine.updateLocation(string(env, json)) }
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeClearRoute")
  public func nativeClearRoute(_ env: Env, _: jclass, _ value: jlong) -> jstring? {
    call(env) { try handle(value).engine.clearRoute() }
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeSnapshot")
  public func nativeSnapshot(_ env: Env, _: jclass, _ value: jlong) -> jstring? {
    call(env) { try handle(value).engine.snapshot() }
  }

  @_cdecl("Java_org_navoss_navigation_core_SwiftNavigationEngine_nativeSetSpeedingWarning")
  public func nativeSetSpeedingWarning(
    _ env: Env, _: jclass, _ value: jlong, _ toleranceKph: jint, _ audible: jboolean
  ) {
    handle(value).engine.setSpeedingWarning(toleranceKph: Int(toleranceKph), audible: audible != 0)
  }
#endif
