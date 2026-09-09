package com.lynx.react.bridge;

import java.util.HashMap;
import java.util.Map;

/** Minimal stub for android/host instrumentation tests. */
public class JavaOnlyMap {
  private final Map<String, Object> values = new HashMap<>();

  public void putString(String key, String value) {
    values.put(key, value);
  }

  public void putBoolean(String key, boolean value) {
    values.put(key, value);
  }

  public Map<String, Object> asHashMap() {
    return values;
  }
}
