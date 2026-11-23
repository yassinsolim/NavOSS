// Spike: loads the Swift navigation core through JNI and drives it from an instrumented test.
// Run ../scripts/stage-jni-libs.sh first; it builds the Swift library and copies the .so files.
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
    getByName("main").jniLibs.srcDir("build/swift-jni-libs")
    getByName("androidTest").assets.srcDirs("../Fixtures", "../../../../test/fixtures/routes-v2")
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
