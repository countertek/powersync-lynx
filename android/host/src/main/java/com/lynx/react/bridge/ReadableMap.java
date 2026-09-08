package com.lynx.react.bridge;

import com.lynx.tasm.TemplateData;
import java.nio.ByteBuffer;
import java.util.HashMap;

public interface ReadableMap {
  boolean hasKey(String name);

  boolean isNull(String name);

  boolean getBoolean(String name);

  double getDouble(String name);

  int getInt(String name);

  long getLong(String name);

  String getString(String name);

  ReadableArray getArray(String name);

  ReadableMap getMap(String name);

  TemplateData getTemplateData(String name);

  byte[] getByteArray(String name);

  PiperData getPiperData(String name);

  ByteBuffer getByteBuffer(String name);

  boolean getBoolean(String name, boolean defaultValue);

  double getDouble(String name, double defaultValue);

  int getInt(String name, int defaultValue);

  long getLong(String name, long defaultValue);

  String getString(String name, String defaultValue);

  ReadableArray getArray(String name, ReadableArray defaultValue);

  ReadableMap getMap(String name, ReadableMap defaultValue);

  byte[] getByteArray(String name, byte[] defaultValue);

  PiperData getPiperData(String name, PiperData defaultValue);

  ByteBuffer getByteBuffer(String name, ByteBuffer defaultValue);

  Dynamic getDynamic(String name);

  ReadableType getType(String name);

  ReadableMapKeySetIterator keySetIterator();

  HashMap<String, Object> toHashMap();

  HashMap<String, Object> asHashMap();

  int size();
}
