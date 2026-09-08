package com.lynx.react.bridge;

import java.nio.ByteBuffer;

public interface WritableMap extends ReadableMap {
  void putNull(String key);

  void putBoolean(String key, boolean value);

  void putDouble(String key, double value);

  void putInt(String key, int value);

  void putLong(String key, long value);

  void putString(String key, String value);

  void putArray(String key, WritableArray value);

  void putMap(String key, WritableMap value);

  void putByteArrayAsString(byte[] key, byte[] value);

  void putByteArray(String key, byte[] value);

  void putPiperData(String key, PiperData value);

  void putByteBuffer(String key, ByteBuffer value);

  void merge(ReadableMap source);
}
