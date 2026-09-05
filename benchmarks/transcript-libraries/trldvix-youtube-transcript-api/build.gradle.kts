plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.github.thoroldvix:youtube-transcript-api:0.4.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.19.2")
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

application {
    mainClass = "bench.Main"
}
