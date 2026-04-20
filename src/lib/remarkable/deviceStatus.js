export function deriveRuntimeState({
  hasHangulRuntime,
  hasBtConfig,
}) {
  if (hasHangulRuntime && hasBtConfig) return "hangul_bt";
  if (hasHangulRuntime) return "hangul";
  if (hasBtConfig) return "bt";
  return "clean";
}

export function getRuntimeStateLabel(runtimeState) {
  switch (runtimeState) {
    case "hangul":
      return "한글 입력 설치됨";
    case "bt":
      return "블루투스 설치됨";
    case "hangul_bt":
      return "한글 입력 + 블루투스 설치됨";
    default:
      return "원본 상태";
  }
}

export function getSafetyStatus({
  connected,
  supported = true,
  runtimeState,
}) {
  if (!connected) {
    return {
      tone: "neutral",
      label: "연결 필요",
      description: "USB 연결과 SSH 비밀번호를 확인하면 기기 상태를 읽습니다.",
    };
  }

  if (!supported) {
    return {
      tone: "danger",
      label: "미지원 기기",
      description: "Paper Pro 계열만 지원합니다.",
    };
  }

  return {
    tone: "safe",
    label: "보증 영향 낮음",
      description: runtimeState === "clean"
      ? "현재는 원본 상태입니다."
      : runtimeState === "hangul_bt"
        ? "현재는 한글 입력과 블루투스 설치가 함께 설치되어 있습니다."
        : runtimeState === "bt"
          ? "현재는 블루투스만 설치되어 있습니다."
          : "현재는 한글 입력 런타임만 설치되어 있습니다.",
  };
}

export function getRecommendedAction({
  connected,
  supported = true,
  runtimeState,
}) {
  if (!connected) {
    return {
      id: "connect",
      title: "기기 연결 확인",
      description: "USB 연결과 SSH 비밀번호를 먼저 확인하세요.",
      href: "/",
    };
  }

  if (!supported) {
    return {
      id: "unsupported",
      title: "지원 기기 확인",
      description: "지원 모델인지 다시 확인하세요.",
      href: "/",
    };
  }

  if (runtimeState === "clean") {
    return {
      id: "safe-install",
      title: "안전 설치 시작",
      description: "한글 입력 설치를 시작합니다. 필요하면 블루투스 설치도 함께 준비할 수 있습니다.",
      href: "/install",
    };
  }

  if (runtimeState === "bt" || runtimeState === "hangul_bt") {
    return {
      id: "check-keyboard",
      title: "키보드 연결 확인",
      description: runtimeState === "bt"
        ? "블루투스 키보드 연결과 입력을 확인하세요."
        : "현재 설치는 끝났습니다. Type Folio 또는 블루투스 키보드에서 입력을 확인하세요.",
      href: "/bluetooth",
    };
  }

  return {
      id: "open-manage",
      title: "설치 상태 확인",
      description: "현재 한글 입력 런타임이 설치되어 있습니다. 설정 변경이나 진단을 진행할 수 있습니다.",
    href: "/manage",
  };
}

export function buildFailureRoutines({
  connected,
  checks,
}) {
  if (!connected) {
    return [
      {
        id: "usb-connection",
        title: "USB 연결 확인",
        steps: [
          "USB 케이블을 다시 연결합니다.",
          "기기에서 개발자 모드와 SSH가 활성화되어 있는지 확인합니다.",
          "설정 화면의 SSH 비밀번호를 다시 입력합니다.",
        ],
      },
    ];
  }

  const routines = [];
  const failingChecks = new Set(checks.filter((check) => !check.pass).map((check) => check.id));

  if (failingChecks.has("bt-config")) {
    routines.push({
      id: "bt-recovery",
      title: "블루투스 복구 루틴",
      steps: [
        "기기와 키보드의 블루투스를 모두 한 번 껐다 켭니다.",
        "키보드를 pairing mode로 다시 넣고 재연결합니다.",
        "필요하면 전체삭제 후 BT만 다시 설치합니다.",
      ],
    });
  }

  if (failingChecks.has("hangul-daemon")) {
    routines.push({
      id: "hangul-runtime",
      title: "한글 입력 런타임 복구",
      steps: [
        "기기를 한 번 재시작합니다.",
        "`systemctl restart hangul-daemon`으로 데몬을 다시 시작합니다.",
        "문제가 계속되면 설치를 한 번 더 실행합니다.",
      ],
    });
  }

  if (failingChecks.has("inactive-slot")) {
    routines.push({
      id: "update-recovery",
      title: "업데이트 슬롯 재준비",
      steps: [
        "현재 설치 상태에서 설치를 한 번 더 실행합니다.",
        "업데이트 직전에는 기기 상태 카드에서 '업데이트 슬롯 준비됨'을 다시 확인합니다.",
      ],
    });
  }

  if (routines.length === 0) {
    routines.push({
      id: "default-check",
      title: "다음 확인 순서",
      steps: [
        "권장 작업 카드를 따라 다음 단계로 진행합니다.",
        "현재 설치한 입력 경로에서 실제 입력을 확인합니다.",
        "이상 징후가 있으면 원상복구보다 먼저 상태 카드를 다시 새로고침합니다.",
      ],
    });
  }

  return routines;
}

export function buildOperationTimeline({
  connected,
  runtimeState,
  checks,
}) {
  const passing = new Set(checks.filter((check) => check.pass).map((check) => check.id));

  return [
    {
      id: "connection",
      label: "기기 연결",
      status: connected ? "done" : "pending",
      detail: connected ? "USB/SSH 확인됨" : "연결 전",
    },
    {
      id: "runtime",
      label: "현재 상태",
      status: connected ? "done" : "pending",
      detail: getRuntimeStateLabel(runtimeState),
    },
    {
      id: "reboot",
      label: "재부팅 유지",
      status: passing.has("reboot-ready") ? "done" : "pending",
      detail: passing.has("reboot-ready") ? "활성 런타임 준비됨" : "점검 필요",
    },
    {
      id: "update",
      label: "업데이트 슬롯",
      status: passing.has("inactive-slot") ? "done" : "pending",
      detail: passing.has("inactive-slot") ? "비활성 슬롯 준비됨" : "재준비 필요",
    },
    {
      id: "factory",
      label: "팩토리리셋 정리",
      status: runtimeState === "clean" || runtimeState === "hangul" || passing.has("factory-guard") ? "done" : "pending",
      detail: runtimeState === "hangul"
        ? "현재 구성에서는 별도 가드가 필요하지 않음"
        : passing.has("factory-guard") || runtimeState === "clean"
          ? "정리 경로 준비됨"
          : "가드 점검 필요",
    },
  ];
}
