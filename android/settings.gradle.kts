dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mailplane-android"

// :core is plain Kotlin/JVM (the mail engine) and builds anywhere.
// :app needs the Android SDK — it is only included when one is configured,
// so `./gradlew :core:test` also works on machines without Android tooling.
include(":core")
if (AndroidSdk.isAvailable(settingsDir)) {
    include(":app")
} else {
    logger.lifecycle("Android SDK not found (ANDROID_HOME / local.properties sdk.dir) — building :core only")
}

object AndroidSdk {
    fun isAvailable(root: java.io.File): Boolean {
        val env = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
        if (!env.isNullOrBlank() && java.io.File(env).isDirectory) return true
        val props = java.io.File(root, "local.properties")
        if (!props.isFile) return false
        val sdkDir = java.util.Properties().apply { props.inputStream().use { load(it) } }.getProperty("sdk.dir")
        return !sdkDir.isNullOrBlank() && java.io.File(sdkDir).isDirectory
    }
}
