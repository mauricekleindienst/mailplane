// Plugins go on the root buildscript classpath so the Kotlin and Android
// Gradle plugins share one classloader. AGP is only added when an Android SDK
// is configured (same check as settings.gradle.kts, which then includes :app),
// so :core builds and tests without access to Google's Maven repository.
buildscript {
    val kotlinVersion = "2.0.21"
    val agpVersion = "8.7.3"

    val androidSdkAvailable: Boolean = run {
        val env = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
        if (!env.isNullOrBlank() && File(env).isDirectory) return@run true
        val props = File(rootDir, "local.properties")
        props.isFile && java.util.Properties()
            .apply { props.inputStream().use { load(it) } }
            .getProperty("sdk.dir")?.let { File(it).isDirectory } == true
    }

    repositories {
        if (androidSdkAvailable) google()
        mavenCentral()
        gradlePluginPortal()
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
        if (androidSdkAvailable) {
            classpath("org.jetbrains.kotlin:compose-compiler-gradle-plugin:$kotlinVersion")
            classpath("com.android.tools.build:gradle:$agpVersion")
        }
    }
}
