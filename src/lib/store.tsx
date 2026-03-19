"use client";

import { createContext, useContext, useState, ReactNode } from "react";

interface SetupState {
  deviceType: "paper-pro-move" | "paper-pro" | null;
  ip: string;
  password: string;
  connected: boolean;
  eulaAgreed: boolean;
  installBtKeyboard: boolean;
  btDeviceAddress: string;
  btDeviceName: string;
  detectedDevice: "paper-pro-move" | "paper-pro" | null;
  deviceModel: string;
}

interface SetupContextType {
  state: SetupState;
  setState: (updates: Partial<SetupState>) => void;
}

const CIPHER_KEY = "ko-remark-v1";
const LEGACY_CIPHER_KEYS = ["remarkable-hangul-setup-v1"];

function encryptValue(text: string): string {
  if (!text) return "";
  const encoded = new TextEncoder().encode(text);
  const key = new TextEncoder().encode(CIPHER_KEY);
  const result = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    result[i] = encoded[i] ^ key[i % key.length];
  }
  return btoa(String.fromCharCode(...result));
}

function decryptValue(cipherText: string): string {
  if (!cipherText) return "";
  const keys = [CIPHER_KEY, ...LEGACY_CIPHER_KEYS];
  for (const keyText of keys) {
    try {
      const bytes = Uint8Array.from(atob(cipherText), (c) => c.charCodeAt(0));
      const key = new TextEncoder().encode(keyText);
      const result = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        result[i] = bytes[i] ^ key[i % key.length];
      }
      return new TextDecoder().decode(result);
    } catch {
      // try next key
    }
  }
  return "";
}

function getStoredValue(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function getStoredEncrypted(key: string): string {
  const raw = getStoredValue(key, "");
  return decryptValue(raw);
}

const defaultState: SetupState = {
  deviceType: null,
  ip: "",
  password: "",
  connected: false,
  eulaAgreed: false,
  installBtKeyboard: true,
  btDeviceAddress: "",
  btDeviceName: "",
  detectedDevice: null,
  deviceModel: "",
};

const SetupContext = createContext<SetupContextType | null>(null);

export function SetupProvider({ children }: { children: ReactNode }) {
  const [state, setStateInternal] = useState<SetupState>(() => ({
    ...defaultState,
    ip: getStoredValue("remarkable-ip", ""),
    password: getStoredEncrypted("remarkable-pw"),
    deviceType: (getStoredValue("remarkable-device", "") as SetupState["deviceType"]) || null,
  }));

  const setState = (updates: Partial<SetupState>) => {
    if (typeof window !== "undefined") {
      try {
        if (updates.ip !== undefined) localStorage.setItem("remarkable-ip", updates.ip);
        if (updates.password !== undefined) localStorage.setItem("remarkable-pw", encryptValue(updates.password));
        if (updates.deviceType !== undefined && updates.deviceType !== null) {
          localStorage.setItem("remarkable-device", updates.deviceType);
        }
      } catch { /* localStorage unavailable */ }
    }
    setStateInternal((prev) => ({ ...prev, ...updates }));
  };

  return (
    <SetupContext.Provider value={{ state, setState }}>
      {children}
    </SetupContext.Provider>
  );
}

export function useSetup() {
  const context = useContext(SetupContext);
  if (!context) throw new Error("useSetup must be used within SetupProvider");
  return context;
}
