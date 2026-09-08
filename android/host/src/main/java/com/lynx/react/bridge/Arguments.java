package com.lynx.react.bridge;

import com.lynx.tasm.TemplateData;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Arguments {
  private Arguments() {}

  public static WritableMap createMap() {
    return new JavaOnlyMap();
  }

  public static WritableArray createArray() {
    return new JavaOnlyArray();
  }
}

final class JavaOnlyMap implements WritableMap {
  private final LinkedHashMap<String, Object> values = new LinkedHashMap<>();

  @Override
  public boolean hasKey(String name) {
    return values.containsKey(name);
  }

  @Override
  public boolean isNull(String name) {
    return hasKey(name) && values.get(name) == null;
  }

  @Override
  public boolean getBoolean(String name) {
    return ((Boolean) values.get(name)).booleanValue();
  }

  @Override
  public double getDouble(String name) {
    return ((Number) values.get(name)).doubleValue();
  }

  @Override
  public int getInt(String name) {
    return ((Number) values.get(name)).intValue();
  }

  @Override
  public long getLong(String name) {
    return ((Number) values.get(name)).longValue();
  }

  @Override
  public String getString(String name) {
    return (String) values.get(name);
  }

  @Override
  public ReadableArray getArray(String name) {
    return (ReadableArray) values.get(name);
  }

  @Override
  public ReadableMap getMap(String name) {
    return (ReadableMap) values.get(name);
  }

  @Override
  public TemplateData getTemplateData(String name) {
    return (TemplateData) values.get(name);
  }

  @Override
  public byte[] getByteArray(String name) {
    return (byte[]) values.get(name);
  }

  @Override
  public PiperData getPiperData(String name) {
    return (PiperData) values.get(name);
  }

  @Override
  public ByteBuffer getByteBuffer(String name) {
    return (ByteBuffer) values.get(name);
  }

  @Override
  public boolean getBoolean(String name, boolean defaultValue) {
    return hasKey(name) && !isNull(name) ? getBoolean(name) : defaultValue;
  }

  @Override
  public double getDouble(String name, double defaultValue) {
    return hasKey(name) && !isNull(name) ? getDouble(name) : defaultValue;
  }

  @Override
  public int getInt(String name, int defaultValue) {
    return hasKey(name) && !isNull(name) ? getInt(name) : defaultValue;
  }

  @Override
  public long getLong(String name, long defaultValue) {
    return hasKey(name) && !isNull(name) ? getLong(name) : defaultValue;
  }

  @Override
  public String getString(String name, String defaultValue) {
    return hasKey(name) && !isNull(name) ? getString(name) : defaultValue;
  }

  @Override
  public ReadableArray getArray(String name, ReadableArray defaultValue) {
    return hasKey(name) && !isNull(name) ? getArray(name) : defaultValue;
  }

  @Override
  public ReadableMap getMap(String name, ReadableMap defaultValue) {
    return hasKey(name) && !isNull(name) ? getMap(name) : defaultValue;
  }

  @Override
  public byte[] getByteArray(String name, byte[] defaultValue) {
    return hasKey(name) && !isNull(name) ? getByteArray(name) : defaultValue;
  }

  @Override
  public PiperData getPiperData(String name, PiperData defaultValue) {
    return hasKey(name) && !isNull(name) ? getPiperData(name) : defaultValue;
  }

  @Override
  public ByteBuffer getByteBuffer(String name, ByteBuffer defaultValue) {
    return hasKey(name) && !isNull(name) ? getByteBuffer(name) : defaultValue;
  }

  @Override
  public Dynamic getDynamic(String name) {
    throw new UnsupportedOperationException();
  }

  @Override
  public ReadableType getType(String name) {
    return JavaOnlyArray.typeOf(values.get(name));
  }

  @Override
  public ReadableMapKeySetIterator keySetIterator() {
    final Iterator<String> keys = values.keySet().iterator();
    return new ReadableMapKeySetIterator() {
      @Override
      public boolean hasNextKey() {
        return keys.hasNext();
      }

      @Override
      public String nextKey() {
        return keys.next();
      }
    };
  }

  @Override
  public HashMap<String, Object> toHashMap() {
    return new HashMap<>(values);
  }

  @Override
  public HashMap<String, Object> asHashMap() {
    return values;
  }

  @Override
  public int size() {
    return values.size();
  }

  @Override
  public void putNull(String key) {
    values.put(key, null);
  }

  @Override
  public void putBoolean(String key, boolean value) {
    values.put(key, Boolean.valueOf(value));
  }

  @Override
  public void putDouble(String key, double value) {
    values.put(key, Double.valueOf(value));
  }

  @Override
  public void putInt(String key, int value) {
    values.put(key, Integer.valueOf(value));
  }

  @Override
  public void putLong(String key, long value) {
    values.put(key, Long.valueOf(value));
  }

  @Override
  public void putString(String key, String value) {
    values.put(key, value);
  }

  @Override
  public void putArray(String key, WritableArray value) {
    values.put(key, value);
  }

  @Override
  public void putMap(String key, WritableMap value) {
    values.put(key, value);
  }

  @Override
  public void putByteArrayAsString(byte[] key, byte[] value) {
    values.put(new String(key), value);
  }

  @Override
  public void putByteArray(String key, byte[] value) {
    values.put(key, value);
  }

  @Override
  public void putPiperData(String key, PiperData value) {
    values.put(key, value);
  }

  @Override
  public void putByteBuffer(String key, ByteBuffer value) {
    values.put(key, value);
  }

  @Override
  public void merge(ReadableMap source) {
    values.putAll(source.asHashMap());
  }

  @Override
  public String toString() {
    StringBuilder out = new StringBuilder("{");
    boolean first = true;
    for (Map.Entry<String, Object> entry : values.entrySet()) {
      if (!first) {
        out.append(",");
      }
      first = false;
      out.append(entry.getKey()).append(":").append(JavaOnlyArray.render(entry.getValue()));
    }
    return out.append("}").toString();
  }
}

final class JavaOnlyArray implements WritableArray {
  private final ArrayList<Object> values = new ArrayList<>();

  static ReadableType typeOf(Object value) {
    if (value == null) {
      return ReadableType.Null;
    }
    if (value instanceof Boolean) {
      return ReadableType.Boolean;
    }
    if (value instanceof Integer) {
      return ReadableType.Int;
    }
    if (value instanceof Long) {
      return ReadableType.Long;
    }
    if (value instanceof Number) {
      return ReadableType.Number;
    }
    if (value instanceof String) {
      return ReadableType.String;
    }
    if (value instanceof ReadableArray) {
      return ReadableType.Array;
    }
    if (value instanceof ReadableMap) {
      return ReadableType.Map;
    }
    if (value instanceof byte[]) {
      return ReadableType.ByteArray;
    }
    if (value instanceof ByteBuffer) {
      return ReadableType.ByteBuffer;
    }
    if (value instanceof PiperData) {
      return ReadableType.PiperData;
    }
    if (value instanceof TemplateData) {
      return ReadableType.TemplateData;
    }
    return ReadableType.LynxObject;
  }

  static String render(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof ReadableMap || value instanceof ReadableArray) {
      return value.toString();
    }
    if (value instanceof String) {
      return "\"" + value + "\"";
    }
    if (value instanceof byte[]) {
      return "byte[" + ((byte[]) value).length + "]";
    }
    return String.valueOf(value);
  }

  @Override
  public int size() {
    return values.size();
  }

  @Override
  public boolean isNull(int index) {
    return values.get(index) == null;
  }

  @Override
  public boolean getBoolean(int index) {
    return ((Boolean) values.get(index)).booleanValue();
  }

  @Override
  public double getDouble(int index) {
    return ((Number) values.get(index)).doubleValue();
  }

  @Override
  public byte getByte(int index) {
    return ((Number) values.get(index)).byteValue();
  }

  @Override
  public short getShort(int index) {
    return ((Number) values.get(index)).shortValue();
  }

  @Override
  public long getLong(int index) {
    return ((Number) values.get(index)).longValue();
  }

  @Override
  public char getChar(int index) {
    return (char) ((Number) values.get(index)).intValue();
  }

  @Override
  public int getInt(int index) {
    return ((Number) values.get(index)).intValue();
  }

  @Override
  public String getString(int index) {
    return (String) values.get(index);
  }

  @Override
  public ReadableArray getArray(int index) {
    return (ReadableArray) values.get(index);
  }

  @Override
  public ReadableMap getMap(int index) {
    return (ReadableMap) values.get(index);
  }

  @Override
  public byte[] getByteArray(int index) {
    return (byte[]) values.get(index);
  }

  @Override
  public PiperData getPiperData(int index) {
    return (PiperData) values.get(index);
  }

  @Override
  public Dynamic getDynamic(int index) {
    throw new UnsupportedOperationException();
  }

  @Override
  public ReadableType getType(int index) {
    return typeOf(values.get(index));
  }

  @Override
  public ArrayList<Object> toArrayList() {
    return new ArrayList<>(values);
  }

  @Override
  public ArrayList<Object> asArrayList() {
    return values;
  }

  @Override
  public void pushNull() {
    values.add(null);
  }

  @Override
  public void pushBoolean(boolean value) {
    values.add(Boolean.valueOf(value));
  }

  @Override
  public void pushDouble(double value) {
    values.add(Double.valueOf(value));
  }

  @Override
  public void pushLong(long value) {
    values.add(Long.valueOf(value));
  }

  @Override
  public void pushInt(int value) {
    values.add(Integer.valueOf(value));
  }

  @Override
  public void pushString(String value) {
    values.add(value);
  }

  @Override
  public void pushArray(WritableArray array) {
    values.add(array);
  }

  @Override
  public void pushMap(WritableMap map) {
    values.add(map);
  }

  @Override
  public void pushByteArray(byte[] array) {
    values.add(array);
  }

  @Override
  public void pushPiperData(PiperData json) {
    values.add(json);
  }

  @Override
  public void pushTemplateData(TemplateData data) {
    values.add(data);
  }

  @Override
  public String toString() {
    StringBuilder out = new StringBuilder("[");
    for (int i = 0; i < values.size(); i++) {
      if (i > 0) {
        out.append(",");
      }
      out.append(render(values.get(i)));
    }
    return out.append("]").toString();
  }
}
