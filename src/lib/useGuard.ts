"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useSetup } from "./store";

// EULA 동의 + 연결 확인 가드
// welcome 페이지(/)와 관리 페이지(/manage, /uninstall)를 제외한 모든 페이지에서 사용
export function useGuard(): boolean {
  const router = useRouter();
  const pathname = usePathname();
  const { state, isLoaded } = useSetup();

  const isWelcome = pathname === "/";
  const allowsCredentialOnly =
    pathname === "/prerequisites"
    || pathname === "/connection"
    || pathname === "/entry"
    || pathname === "/manage"
    || pathname === "/uninstall"
    || pathname === "/bluetooth";
  const isAllowed = state.eulaAgreed && state.connected;
  const hasCredentials = Boolean(state.ip && state.password);

  useEffect(() => {
    if (!isLoaded) return;
    if (isWelcome) return;
    if (allowsCredentialOnly && hasCredentials) return;
    if (!isAllowed) router.replace("/");
  }, [isLoaded, isWelcome, allowsCredentialOnly, isAllowed, hasCredentials, router]);

  if (!isLoaded) return false;
  return isAllowed || isWelcome || (allowsCredentialOnly && hasCredentials);
}
