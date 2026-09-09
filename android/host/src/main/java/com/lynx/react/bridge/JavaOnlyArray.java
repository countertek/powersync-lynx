package com.lynx.react.bridge;

import java.util.ArrayList;
import java.util.List;

/** Minimal stub for android/host instrumentation tests. */
public class JavaOnlyArray {
  private final List<Object> values = new ArrayList<>();

  public void pushMap(JavaOnlyMap map) {
    values.add(map);
  }

  public void pushString(String value) {
    values.add(value);
  }

  public List<Object> asList() {
    return values;
  }
}
