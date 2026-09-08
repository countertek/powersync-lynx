package com.lynx.react.bridge;

import com.lynx.tasm.TemplateData;

public interface WritableArray extends ReadableArray {
  void pushNull();

  void pushBoolean(boolean value);

  void pushDouble(double value);

  void pushLong(long value);

  void pushInt(int value);

  void pushString(String value);

  void pushArray(WritableArray array);

  void pushMap(WritableMap map);

  void pushByteArray(byte[] array);

  void pushPiperData(PiperData json);

  void pushTemplateData(TemplateData data);
}
