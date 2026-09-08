package com.lynx.react.bridge;

import java.util.ArrayList;

public interface ReadableArray {
  int size();

  boolean isNull(int index);

  boolean getBoolean(int index);

  double getDouble(int index);

  byte getByte(int index);

  short getShort(int index);

  long getLong(int index);

  char getChar(int index);

  int getInt(int index);

  String getString(int index);

  ReadableArray getArray(int index);

  ReadableMap getMap(int index);

  byte[] getByteArray(int index);

  PiperData getPiperData(int index);

  Dynamic getDynamic(int index);

  ReadableType getType(int index);

  ArrayList<Object> toArrayList();

  ArrayList<Object> asArrayList();
}
