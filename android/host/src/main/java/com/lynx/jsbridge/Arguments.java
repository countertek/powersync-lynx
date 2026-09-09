package com.lynx.jsbridge;

import com.lynx.react.bridge.WritableArray;
import com.lynx.react.bridge.WritableMap;

/** Host-test alias; production Lynx exposes Arguments on this package. */
public final class Arguments {
  private Arguments() {}

  public static WritableMap createMap() {
    return com.lynx.react.bridge.Arguments.createMap();
  }

  public static WritableArray createArray() {
    return com.lynx.react.bridge.Arguments.createArray();
  }
}
