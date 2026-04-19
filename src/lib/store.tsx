"use client";

import { createContext, useContext, useState, useEffect, ReactNode, useMemo, useCallback } from "react";

interface SetupState {
  deviceType: "paper-pro-move" | "paper-pro" | null;
  ip: string;
  password: string;
  connected: boolean;
  eulaAgreed: boolean;
  installHangul: boolean;
  installBtKeyboard: boolean;
  swapLeftCtrlCapsLock: boolean;
  btDeviceAddress: string;
  btDeviceName: string;
  detectedDevice: "paper-pro-move" | "paper-pro" | null;
  deviceModel: string;
}

interface SetupContextType {
  state: SetupState;
  setState: (updates: Partial<SetupState>) => void;
  isLoaded: boolean;
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
  installHangul: true,
  installBtKeyboard: false,
  swapLeftCtrlCapsLock: false,
  btDeviceAddress: "",
  btDeviceName: "",
  detectedDevice: null,
  deviceModel: "",
};

const SetupContext = createContext<SetupContextType | null>(null);

export function SetupProvider({ children }: { children: ReactNode }) {
  const [state, setStateInternal] = useState<SetupState>(defaultState);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // 마운트 후 localStorage에서 로드하여 하이드레이션 오류 방지
    const loadedState: Partial<SetupState> = {
      ip: getStoredValue("remarkable-ip", ""),
      password: getStoredEncrypted("remarkable-pw"),
      deviceType: (getStoredValue("remarkable-device", "") as SetupState["deviceType"]) || null,
      swapLeftCtrlCapsLock: getStoredValue("remarkable-swap-left-ctrl-capslock", "") === "1",
    };
    setStateInternal((prev) => ({ ...prev, ...loadedState }));
    setIsLoaded(true);
  }, []);

  const setState = useCallback((updates: Partial<SetupState>) => {
    setStateInternal((prev) => {
      const next = { ...prev, ...updates };
      if (typeof window !== "undefined") {
        try {
          if (updates.ip !== undefined) localStorage.setItem("remarkable-ip", next.ip);
          if (updates.password !== undefined) localStorage.setItem("remarkable-pw", encryptValue(next.password));
          if (updates.deviceType !== undefined && updates.deviceType !== null) {
            localStorage.setItem("remarkable-device", updates.deviceType);
          }
          if (updates.swapLeftCtrlCapsLock !== undefined) {
            localStorage.setItem(
              "remarkable-swap-left-ctrl-capslock",
              next.swapLeftCtrlCapsLock ? "1" : "0",
            );
          }
        } catch { /* localStorage unavailable */ }
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ state, setState, isLoaded }), [state, setState, isLoaded]);

  return (
    <SetupContext.Provider value={value}>
      {children}
    </SetupContext.Provider>
  );
}

export function useSetup() {
  const context = useContext(SetupContext);
  if (!context) throw new Error("useSetup must be used within SetupProvider");
  return context;
}
