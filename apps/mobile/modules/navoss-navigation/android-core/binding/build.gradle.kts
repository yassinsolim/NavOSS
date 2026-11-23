// The Kotlin binding of the Swift navigation core and its instrumented test. The Expo module
// compiles the same sources (src/main); this project exists to test them against the real
// library on a device. Build the libraries first: apps/mobile/scripts/build-android-core.sh.
plugins {
  id("com.android.library") version "8.12.0"
  id("org.jetbrains.kotlin.android") version "2.1.20"
}

android {
  namespace = "org.navoss.navigation.core"
  compileSdk = 36
  defaultConfig {
    minSdk = 28
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    ndk { abiFilters += "arm64-v8a" }
  }
  sourceSets {
    getByName("main").jniLibs.srcDir("../build/jniLibs")
    getByName("androidTest").assets.srcDirs(
      "../Tests/Fixtures",
      "../../../../test/fixtures/routes-v2",
      "../../../../test/fixtures/server-config",
    )
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("junit:junit:4.13.2")
}
