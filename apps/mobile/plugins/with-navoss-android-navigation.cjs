const { AndroidConfig, withAndroidManifest, withAppBuildGradle } = require('@expo/config-plugins');

const SERVICE_NAME = 'org.navoss.mobile.navigation.NavigationForegroundService';

/**
 * What turn-by-turn guidance needs from the manifest: a `location` foreground service that keeps
 * a trip running with the screen off, the permissions to start it, and the notification it shows.
 * The service is started only while the app is visible, so there is no background-location
 * permission.
 */
const PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
];

/** Add each permission once, keeping any already declared. */
function withNavigationPermissions(manifest) {
  const declared = (manifest.manifest['uses-permission'] ??= []);
  for (const name of PERMISSIONS) {
    if (!declared.some((item) => item.$['android:name'] === name)) {
      declared.push({ $: { 'android:name': name } });
    }
  }
  return manifest;
}

/** Declare the navigation service once, replacing an earlier declaration of it. */
function withNavigationService(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const services = (application.service ??= []);
  const service = {
    $: {
      'android:name': SERVICE_NAME,
      'android:exported': 'false',
      'android:foregroundServiceType': 'location',
    },
  };
  const index = services.findIndex((item) => item.$['android:name'] === SERVICE_NAME);
  if (index === -1) {
    services.push(service);
  } else {
    services[index] = service;
  }
  return manifest;
}

const LIBCXX_MARKER = '// NavOSS: package NDK r30 libc++_shared.so';

/**
 * The Swift core's runtime needs NDK r30's `libc++_shared.so` (it imports
 * `std::__ndk1::__hash_memory`, which React Native's r27 copy lacks), and one process loads only
 * one copy. React Native's `pickFirst` silently keeps its own, so after every variant's native
 * libraries are merged the r30 copy that `scripts/build-android-core.sh` puts in `jniLibs`
 * replaces it, and the build fails if the stripped library about to be packaged is not r30.
 * Without the core libraries (guidance unavailable) React Native's copy is left alone.
 * See docs/architecture/android-core.md, "C++ runtime".
 */
const LIBCXX_GRADLE = `
${LIBCXX_MARKER}
def navossCoreLibraries = new File(rootDir, "../modules/navoss-navigation/android-core/build/jniLibs/arm64-v8a")
def navossLibcxx = new File(navossCoreLibraries, "libc++_shared.so")
def navossHasSymbol = { File library ->
  new String(library.bytes, "ISO-8859-1").contains("_ZNSt6__ndk113__hash_memoryEPKvm")
}
android.applicationVariants.configureEach { variant ->
  def name = variant.name.capitalize()
  tasks.named("merge\${name}NativeLibs").configure { task ->
    task.doLast {
      if (!new File(navossCoreLibraries, "libNavOSSCore.so").exists()) return
      task.outputs.files.asFileTree.matching { include "**/arm64-v8a/libc++_shared.so" }.each { merged ->
        java.nio.file.Files.copy(navossLibcxx.toPath(), merged.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
      }
    }
  }
  tasks.named("strip\${name}DebugSymbols").configure { task ->
    task.doLast {
      def packaged = task.outputs.files.asFileTree.matching { include "**/arm64-v8a/*.so" }.files
      if (!packaged.any { it.name == "libNavOSSCore.so" }) return
      def libcxx = packaged.find { it.name == "libc++_shared.so" }
      if (libcxx == null || !navossHasSymbol(libcxx)) {
        throw new GradleException("NavOSS: the packaged libc++_shared.so is not NDK r30's; the Swift navigation core cannot run with it.")
      }
    }
  }
}
`;

/** Append the libc++ replacement once to `app/build.gradle`. */
function withLibcxxReplacement(buildGradle) {
  if (buildGradle.includes(LIBCXX_MARKER)) return buildGradle;
  return `${buildGradle.trimEnd()}\n${LIBCXX_GRADLE}`;
}

function withNavOSSAndroidNavigation(config) {
  config = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = withNavigationService(withNavigationPermissions(modConfig.modResults));
    return modConfig;
  });
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = withLibcxxReplacement(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withNavOSSAndroidNavigation;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.withNavigationPermissions = withNavigationPermissions;
module.exports.withNavigationService = withNavigationService;
module.exports.withLibcxxReplacement = withLibcxxReplacement;
