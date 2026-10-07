plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose") }
android {
    namespace = "dev.pocketbridge"
    compileSdk = 36
    useLibrary("android.test.runner", false)
    useLibrary("android.test.base", false)
    defaultConfig { applicationId = "dev.pocketbridge"; minSdk = 26; targetSdk = 36; versionCode = 18; versionName = "0.8.7" }
    defaultConfig.testInstrumentationRunnerArguments["class"] = "dev.pocketbridge.ImageOrientationTest,dev.pocketbridge.ConnectionStateTest,dev.pocketbridge.HttpsConnectionTest"
    val signingKey = System.getenv("POCKETBRIDGE_SIGNING_KEY")
    if (!signingKey.isNullOrBlank()) {
        signingConfigs.create("personal") {
            storeFile = file(signingKey)
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("personal")
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.04.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
