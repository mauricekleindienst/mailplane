plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Version comes from the desktop package.json so both apps release in lockstep
// (the release workflow tags vX.Y.Z; versionCode = X*10000 + Y*100 + Z).
val appVersion: String = run {
    val pkg = rootProject.file("../package.json")
    Regex("\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+)").find(if (pkg.isFile) pkg.readText() else "")?.groupValues?.get(1) ?: "1.0.0"
}
val appVersionCode: Int = appVersion.split('.').map { it.toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }

android {
    namespace = "app.mailplane.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.mailplane.android"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
    }

    // Release signing from environment (CI secrets). Without them the release
    // build falls back to the debug key so CI still produces an installable APK.
    val keystorePath = System.getenv("MAILPLANE_KEYSTORE_PATH")
    signingConfigs {
        if (!keystorePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("MAILPLANE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("MAILPLANE_KEY_ALIAS")
                keyPassword = System.getenv("MAILPLANE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // javax.mail relies on reflection/service files — keep it unshrunk
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Screenshot tests: Robolectric renders the Compose screens on the JVM and
    // Roborazzi writes PNGs to build/outputs/roborazzi (CI uploads them)
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { it.systemProperty("roborazzi.test.record", "true") }
        }
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/LICENSE.md", "META-INF/NOTICE.md", "META-INF/LICENSE", "META-INF/NOTICE",
                "META-INF/mailcap", "META-INF/javamail.*", "META-INF/DEPENDENCIES",
            )
        }
    }
}

dependencies {
    implementation(project(":core"))
    // Official Android build of the javax.mail 1.6 API that :core is written against
    implementation("com.sun.mail:android-mail:1.6.7")
    implementation("com.sun.mail:android-activation:1.6.7")

    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.32.2")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.32.2")
    testImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
