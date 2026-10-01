cmake_minimum_required(VERSION 3.24)

project(streamee_nvfruc LANGUAGES CXX)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Streamee NVFRUC currently supports Windows x64 only")
endif()

if(NOT DEFINED VAPOURSYNTH_INCLUDE_DIR)
  FetchContent_Declare(
    vapoursynth_headers
    GIT_REPOSITORY https://github.com/vapoursynth/vapoursynth.git
    GIT_TAG 03c8b6719f202b162284f53efc5b50632f70f72e
    GIT_SHALLOW FALSE
  )
  FetchContent_MakeAvailable(vapoursynth_headers)
  set(VAPOURSYNTH_INCLUDE_DIR "${vapoursynth_headers_SOURCE_DIR}/include")
endif()

add_library(streamee_nvfruc SHARED
  src/nvfruc_abi.hpp
  src/nv12_rows.hpp
  src/streamee_nvfruc.cpp
)

target_include_directories(streamee_nvfruc PRIVATE "${VAPOURSYNTH_INCLUDE_DIR}")
target_compile_definitions(streamee_nvfruc PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
  VS_USE_API_41
  _SILENCE_CXX20_U8PATH_DEPRECATION_WARNING
)
target_compile_options(streamee_nvfruc PRIVATE /W4 /permissive- /EHsc /utf-8)

set_target_properties(streamee_nvfruc PROPERTIES
  OUTPUT_NAME "streamee_nvfruc"
  PREFIX ""
)

include(CTest)
if(BUILD_TESTING)
  add_executable(nv12_rows_test tests/nv12_rows.cpp)
  add_test(NAME nv12_rows COMMAND nv12_rows_test)
endif()
