cmake_minimum_required(VERSION 3.22.1)
project(pdfengine)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Prebuilt PDFium shared library. Fetched per-ABI into src/main/jniLibs/<abi>/libpdfium.so by the
# Gradle "ensurePdfium" step (see app/build.gradle, Decision A — binaries are not committed).
add_library(pdfium SHARED IMPORTED)
set_target_properties(pdfium PROPERTIES
        IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libpdfium.so)

# Our thin JNI binding around the PDFium FPDFEdit/render API.
add_library(pdfengine SHARED pdfium_jni.cpp)

target_include_directories(pdfengine PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/pdfium/include)

find_library(log-lib log)
find_library(jnigraphics-lib jnigraphics)

target_link_libraries(pdfengine pdfium ${log-lib} ${jnigraphics-lib})
