plugins {
    id("org.jetbrains.kotlin.jvm")
    `java-library`
}

// Java 17 bytecode — what Android (AGP 8) consumes; builds with any JDK ≥ 17
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

// The engine is written against the javax.mail 1.6 API. On Android the app
// supplies com.sun.mail:android-mail (the official Android build of the same
// API); on the JVM (tests, tooling) jakarta.mail 1.6.7 provides it.
dependencies {
    compileOnly("com.sun.mail:jakarta.mail:1.6.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")

    testImplementation(kotlin("test"))
    testImplementation("com.sun.mail:jakarta.mail:1.6.7")
    testImplementation("com.icegreen:greenmail-junit5:1.6.15")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("passed", "failed", "skipped"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
