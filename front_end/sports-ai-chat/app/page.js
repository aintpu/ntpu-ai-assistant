"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

// ─── 多語言文字 ───────────────────────────────────────────────────────────────

const LABELS = {
  zh: {
    title: "NTPU AI Assistant",
    newChat: "新對話",
    placeholder: "輸入訊息… (Enter 送出，Shift+Enter 換行)",
    send: "送出",
    disclaimer: "📌 回答由 AI 整理，最新資訊請以各單位官方公告為準。",
    sources: "參考來源",
    langLabel: "語言",
    welcome: "有什麼我能幫你的？",
    welcomeSub: "體育室・通識中心・語言中心・教務處・學務處 相關問題皆可詢問",
    uploadTitle: "上傳圖片",
    voiceTitle: "語音輸入",
    recording: "錄音中，再按一次停止…",
    voiceLabel: "（語音輸入）",
    playAudio: "▶ 播放語音回覆",
    connError: "無法連線，請稍後再試。",
    micError: "無法存取麥克風，請確認瀏覽器權限設定。",
    lightMode: "淺色模式",
    darkMode: "深色模式",
    settings: "設定",
    about: "系統說明",
    aboutTitle: "系統特色、使用方式與服務範圍（另開新分頁）",
    fbGood: "這個回答有幫助",
    fbBad: "這個回答有問題",
    fbTitle: "這個回答哪裡有問題？（可複選）",
    fbReasons: {
      wrong_info: "資訊錯誤，與實際規定不符",
      outdated: "資訊過時",
      off_topic: "答非所問，沒回答到我的問題",
      too_vague: "太籠統，不夠具體",
      bad_source: "找不到出處，或來源連結有誤",
      other: "其他",
    },
    fbCommentPlaceholder: "可以再多說一點嗎？（選填）",
    fbPrivacy: "請勿填寫身分證字號、學號等個人資料。",
    fbSubmit: "送出",
    fbCancel: "取消",
    fbThanks: "感謝你的回饋！",
  },
  en: {
    title: "NTPU AI Assistant",
    newChat: "New Chat",
    placeholder: "Type your message… (Enter to send, Shift+Enter for newline)",
    send: "Send",
    disclaimer: "📌 AI-generated answers. Please refer to official announcements for the latest information.",
    sources: "Sources",
    langLabel: "Language",
    welcome: "How can I help you?",
    welcomeSub:
      "Ask about Sports Center, General Education, Language Center, Academic Affairs, or Student Affairs",
    uploadTitle: "Upload image",
    voiceTitle: "Voice input",
    recording: "Recording… click again to stop",
    voiceLabel: "(Voice input)",
    playAudio: "▶ Play audio response",
    connError: "Connection failed. Please try again later.",
    micError: "Microphone access denied. Check your browser permissions.",
    lightMode: "Light mode",
    darkMode: "Dark mode",
    settings: "Settings",
    about: "About this system",
    aboutTitle: "Features, usage, and coverage (opens in a new tab)",
    fbGood: "This answer was helpful",
    fbBad: "Something's wrong with this answer",
    fbTitle: "What was wrong with this answer? (select all that apply)",
    fbReasons: {
      wrong_info: "Incorrect — doesn't match the actual rules",
      outdated: "Out of date",
      off_topic: "Didn't answer my question",
      too_vague: "Too vague, not specific enough",
      bad_source: "No source, or the source link is wrong",
      other: "Other",
    },
    fbCommentPlaceholder: "Anything more you'd like to add? (optional)",
    fbPrivacy: "Please don't include personal data such as ID or student numbers.",
    fbSubmit: "Submit",
    fbCancel: "Cancel",
    fbThanks: "Thanks for your feedback!",
  },
};

// 與後端 FEEDBACK_REASONS 白名單一致；後端會再過濾一次
const FEEDBACK_REASON_KEYS = ["wrong_info", "outdated", "off_topic", "too_vague", "bad_source", "other"];

const QUICK_QUESTIONS = {
  zh: [
    "綜合體育館可以借用嗎？",
    "運動代表隊如何加入？",
    "大學英文抵免及免修方式",
    "外語能力畢業門檻",
    "通識課夏季學院怎麼選課",
    "向度通識畢業門檻",
    "辦理休學需要哪些程序？",
    "學分抵免的規定為何？",
    "弱勢學生助學金如何申請？",
    "宿舍住宿管理規定",
  ],
  en: [
    "Can I book the Sports Center?",
    "How to join a sports team?",
    "How to waive the college English requirement?",
    "Foreign language graduation requirements",
    "How to enroll in General Education summer courses?",
    "GE domain graduation requirements",
    "What is the procedure for taking a leave of absence?",
    "What are the rules for credit transfer?",
    "How to apply for a financial-need scholarship?",
    "Dormitory management regulations",
  ],
};

// ─── 品牌主色 ─────────────────────────────────────────────────────────────────

const BRAND = "#1e3a6e";
const BRAND_HOVER = "#163059";

// ─── 工具函式 ──────────────────────────────────────────────────────────────────

function fileToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

function playBase64Audio(base64, mime = "audio/mp3") {
  const audio = new Audio(`data:${mime};base64,${base64}`);
  audio.play().catch(() => {});
}

// ─── 主題色表（傳入 isDark，回傳 Tailwind class 字串） ────────────────────────

function buildTheme(isDark) {
  return isDark
    ? {
        root:           "bg-[#0f1117] text-gray-100",
        sidebar:        "bg-[#1a2035] border-gray-700",
        sidebarBtn:     "text-gray-300 hover:bg-[#252d47]",
        sidebarMeta:    "text-gray-500",
        sidebarCurrent: "bg-[#252d47] text-gray-200",
        sidebarBorder:  "border-gray-700",
        header:         "bg-[#0f1117] border-gray-700",
        headerText:     "text-gray-100",
        main:           "bg-[#0f1117]",
        welcomeTitle:   "text-gray-100",
        welcomeSub:     "text-gray-400",
        quickBtn:       "border-gray-600 text-gray-300 hover:border-blue-400 hover:text-blue-300 bg-transparent",
        bubbleUser:     "text-white",
        bubbleAi:       "bg-[#1e2433] text-gray-100",
        bubbleStatus:   "text-gray-500 italic animate-pulse",
        bubbleError:    "bg-red-900/30 text-red-400 border border-red-800",
        typing:         "bg-[#1e2433]",
        typingDot:      "bg-gray-500",
        sourceWrap:     "text-gray-400",
        sourceLink:     "text-blue-400 hover:underline",
        sourceText:     "text-gray-500",
        footer:         "bg-[#0f1117] border-gray-700",
        inputBorder:    "border-gray-600",
        inputBg:        "bg-[#1e2433]",
        inputText:      "text-gray-100",
        inputDisabled:  "bg-[#1a2035]",
        inputFocus:     "focus:ring-blue-500",
        iconBtn:        "text-gray-500 hover:text-gray-200",
        sendEnabled:    `text-white`,
        sendDisabled:   "bg-gray-700 text-gray-500",
        disclaimer:     "text-gray-600",
        clearBtnImg:    "bg-gray-600 hover:bg-red-600 text-white",
        audioBtn:       "text-blue-400 hover:underline",
        placeholder:    "placeholder-gray-500",
        settingsPanel:  "bg-[#252d47] border-gray-600 shadow-black/40",
        settingsDivider:"border-gray-700",
        settingsItem:   "text-gray-300 hover:bg-[#2f3a55]",
      }
    : {
        root:           "bg-white text-gray-900",
        sidebar:        "bg-[#f5f7fa] border-gray-200",
        sidebarBtn:     "text-gray-700 hover:bg-gray-200",
        sidebarMeta:    "text-gray-400",
        sidebarCurrent: "bg-gray-200 text-gray-600",
        sidebarBorder:  "border-gray-200",
        header:         "bg-white border-gray-200",
        headerText:     "text-gray-900",
        main:           "bg-white",
        welcomeTitle:   "text-gray-900",
        welcomeSub:     "text-gray-400",
        quickBtn:       "border-gray-200 text-gray-600 hover:border-[#1e3a6e] hover:text-[#1e3a6e] bg-white",
        bubbleUser:     "text-white",
        bubbleAi:       "bg-gray-100 text-gray-900",
        bubbleStatus:   "text-gray-400 italic animate-pulse",
        bubbleError:    "bg-red-50 text-red-600 border border-red-200",
        typing:         "bg-gray-100",
        typingDot:      "bg-gray-400",
        sourceWrap:     "text-gray-500",
        sourceLink:     "text-[#1e3a6e] hover:underline",
        sourceText:     "text-gray-400",
        footer:         "bg-white border-gray-200",
        inputBorder:    "border-gray-300",
        inputBg:        "bg-white",
        inputText:      "text-gray-900",
        inputDisabled:  "bg-gray-50",
        inputFocus:     "focus:ring-[#1e3a6e]",
        iconBtn:        "text-gray-400 hover:text-gray-700",
        sendEnabled:    "text-white",
        sendDisabled:   "bg-gray-300 text-white",
        disclaimer:     "text-gray-400",
        clearBtnImg:    "bg-gray-700 hover:bg-red-600 text-white",
        audioBtn:       "text-[#1e3a6e] hover:underline",
        placeholder:    "placeholder-gray-400",
        settingsPanel:  "bg-white border-gray-200 shadow-gray-200/80",
        settingsDivider:"border-gray-100",
        settingsItem:   "text-gray-700 hover:bg-gray-50",
      };
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function MicIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
    </svg>
  );
}

function ImageIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  );
}

function PlusIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

function MenuIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function SendIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function SunIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z" />
    </svg>
  );
}

function MoonIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" />
    </svg>
  );
}

function SettingsIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  );
}

function ThumbUpIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4.5-7a2 2 0 0 1 3.6 1.5L14 9h5a2 2 0 0 1 2 2.4l-1.6 7A2 2 0 0 1 17.4 20H7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThumbDownIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 14V3H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3zm0 0 4.5 7a2 2 0 0 0 3.6-1.5L14 15h5a2 2 0 0 0 2-2.4l-1.6-7A2 2 0 0 0 17.4 4H7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}

// 外部連結指示（右上小箭頭）
function ExternalLinkIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 3h6v6M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 畢業帽 icon（代表 NTPU 大學識別）
function NtpuLogo() {
  return (
    <div
      className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
      style={{ background: BRAND }}
    >
      <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
        <path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z" />
      </svg>
    </div>
  );
}

// ─── 回答評價 ─────────────────────────────────────────────────────────────────
// 讚：一鍵送出。倦：先展開原因複選與選填文字，再送出。
// 預設分類讓回饋可以彙總統計，文字欄補個案細節。
function AnswerFeedback({ messageId, sessionId, lang, T }) {
  const labels = LABELS[lang];
  const [state, setState] = useState("idle");   // idle | form | sent
  const [reasons, setReasons] = useState([]);
  const [comment, setComment] = useState("");

  const send = async (rating, reasonList = [], text = "") => {
    setState("sent");   // 樂觀更新：回饋送不出去不該打擾使用者
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message_id: messageId,
          session_id: sessionId,
          rating,
          reasons: reasonList,
          comment: text,
        }),
      });
    } catch {
      /* 回饋失敗不影響對話，靜默略過 */
    }
  };

  const toggle = (key) =>
    setReasons(rs => rs.includes(key) ? rs.filter(r => r !== key) : [...rs, key]);

  if (state === "sent") {
    return <div className={`mt-2 px-1 text-xs ${T.sourceText}`}>{labels.fbThanks}</div>;
  }

  if (state === "form") {
    return (
      <div className={`mt-2 rounded-xl border p-3 text-xs ${T.settingsPanel}`}>
        <div className="mb-2 font-medium">{labels.fbTitle}</div>
        <div className="mb-2 flex flex-col gap-1.5">
          {FEEDBACK_REASON_KEYS.map(key => (
            <label key={key} className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={reasons.includes(key)}
                onChange={() => toggle(key)}
                className="mt-0.5 shrink-0"
              />
              <span>{labels.fbReasons[key]}</span>
            </label>
          ))}
        </div>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value.slice(0, 500))}
          placeholder={labels.fbCommentPlaceholder}
          rows={2}
          className={`w-full resize-none rounded-lg border px-2 py-1.5 text-xs ${T.inputBorder} ${T.inputBg} ${T.inputText} ${T.placeholder} focus:outline-none focus:ring-1 ${T.inputFocus}`}
        />
        <div className={`mt-1 ${T.sourceText}`}>{labels.fbPrivacy}</div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => send("down", reasons, comment)}
            style={{ background: BRAND }}
            className={`rounded-lg px-3 py-1.5 font-medium transition-opacity hover:opacity-90 ${T.sendEnabled}`}
          >
            {labels.fbSubmit}
          </button>
          <button onClick={() => setState("idle")} className={`px-2 py-1.5 ${T.sourceText}`}>
            {labels.fbCancel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-1 px-1">
      <button
        onClick={() => send("up")}
        title={labels.fbGood}
        aria-label={labels.fbGood}
        className={`rounded-md p-1.5 transition-colors ${T.sidebarBtn}`}
      >
        <ThumbUpIcon className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => setState("form")}
        title={labels.fbBad}
        aria-label={labels.fbBad}
        className={`rounded-md p-1.5 transition-colors ${T.sidebarBtn}`}
      >
        <ThumbDownIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── 訊息氣泡 ─────────────────────────────────────────────────────────────────

function MessageBubble({ msg, lang, T, sessionId }) {
  const labels = LABELS[lang];

  if (msg.role === "user") {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[88%] sm:max-w-[75%]">
          {msg.imagePreview && (
            <div className="mb-1 flex justify-end">
              <img src={msg.imagePreview} alt="uploaded" className="max-h-40 rounded-xl border border-blue-300/40" />
            </div>
          )}
          {msg.content && (
            <div
              className={`rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed break-words flex items-center gap-2 ${T.bubbleUser}`}
              style={{ background: BRAND }}
            >
              {msg.isVoice && <MicIcon className="w-3.5 h-3.5 shrink-0 opacity-70" />}
              {msg.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (msg.status === "ok") {
    return (
      <div className="flex justify-start mb-4">
        <div className="min-w-0 max-w-[92%] sm:max-w-[78%]">
          <div className={`rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed break-words markdown-body ${T.bubbleAi}`}>
            {msg.content ? (
              <ReactMarkdown
                components={{
                  a: ({ node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" className={T.sourceLink} />
                  ),
                }}
              >
                {msg.content}
              </ReactMarkdown>
            ) : msg.statusText ? (
              <span className={T.bubbleStatus}>{msg.statusText}</span>
            ) : null}
          </div>

          {msg.audioBase64 && (
            <button onClick={() => playBase64Audio(msg.audioBase64)} className={`mt-1.5 ml-1 text-xs ${T.audioBtn}`}>
              {labels.playAudio}
            </button>
          )}

          {msg.sources && msg.sources.length > 0 && (
            <div className={`mt-2 px-1 text-xs ${T.sourceWrap}`}>
              <div className="font-medium mb-1">{labels.sources}：</div>
              <ul className="space-y-0.5">
                {msg.sources.map((s, i) => (
                  <li key={i}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className={T.sourceLink}>{s.title}</a>
                    ) : (
                      <span className={T.sourceText}>{s.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 回答完整結束（有 message_id）才顯示評價，串流中途不顯示 */}
          {msg.messageId && msg.content && (
            <AnswerFeedback messageId={msg.messageId} sessionId={sessionId} lang={lang} T={T} />
          )}
        </div>
      </div>
    );
  }

  if (msg.status === "error") {
    return (
      <div className="flex justify-start mb-4">
        <div className={`rounded-2xl rounded-tl-sm px-4 py-2.5 max-w-[92%] sm:max-w-[75%] text-sm leading-relaxed break-words ${T.bubbleError}`}>
          ⚠️ {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className={`rounded-2xl rounded-tl-sm px-4 py-2.5 max-w-[92%] sm:max-w-[75%] text-sm leading-relaxed italic break-words ${T.bubbleAi} opacity-70`}>
        {msg.content}
      </div>
    </div>
  );
}

function TypingIndicator({ T }) {
  return (
    <div className="flex justify-start mb-4">
      <div className={`rounded-2xl rounded-tl-sm px-4 py-3 flex gap-1 items-center ${T.typing}`}>
        <span className={`w-2 h-2 rounded-full animate-bounce [animation-delay:0ms] ${T.typingDot}`} />
        <span className={`w-2 h-2 rounded-full animate-bounce [animation-delay:150ms] ${T.typingDot}`} />
        <span className={`w-2 h-2 rounded-full animate-bounce [animation-delay:300ms] ${T.typingDot}`} />
      </div>
    </div>
  );
}

// ─── 主頁面 ───────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [lang, setLang] = useState("zh");
  const [isDark, setIsDark] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [isRecording, setIsRecording] = useState(false);

  const sessionId = useRef(crypto.randomUUID());
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const settingsRef = useRef(null);

  const labels = LABELS[lang];
  const T = buildTheme(isDark);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (!showSettings) return;
    const handler = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSettings]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [sidebarOpen]);

  const buildHistory = (msgs) =>
    msgs.map((m) => ({ role: m.role, content: m.role === "user" ? m.content : (m.rawAnswer ?? m.content) }));

  const handleImageSelect = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setImagePreview(URL.createObjectURL(file));
    setImageBase64(await fileToBase64(file));
  };

  const clearImage = () => {
    setImagePreview(null);
    setImageBase64(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleNewChat = () => {
    setMessages([]);
    setInput("");
    clearImage();
    setSidebarOpen(false);
  };

  const sendMessage = async (overrideText, isVoice = false, voiceBase64 = null) => {
    const question = (overrideText ?? input).trim();
    if ((!question && !imageBase64 && !voiceBase64) || loading) return;

    const userMsg = { role: "user", content: question, imagePreview: imagePreview ?? null, isVoice };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    clearImage();
    setLoading(true);
    let responseMessages = nextMessages;

    try {
      let data;

      if (voiceBase64) {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_base64: voiceBase64, history: buildHistory(messages), session_id: sessionId.current }),
        });
        data = await res.json();
        if (data.question) {
          responseMessages = nextMessages.map((message, index) =>
            index === nextMessages.length - 1 ? { ...message, content: data.question } : message
          );
          setMessages(responseMessages);
        }
      } else if (imageBase64) {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history: buildHistory(messages), session_id: sessionId.current, image_base64: imageBase64 }),
        });
        data = await res.json();
      } else {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history: buildHistory(messages), session_id: sessionId.current }),
        });
        if (!res.ok || !res.body) throw new Error("stream failed");

        let current = { role: "assistant", status: "ok", content: "", rawAnswer: "", sources: [], statusText: "" };
        const push = () => setMessages([...nextMessages, { ...current }]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let gotAnything = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let evt;
            try { evt = JSON.parse(line.slice(5)); } catch { continue; }
            gotAnything = true;
            if (evt.type === "status")  { current.statusText = evt.text; current.content = ""; setLoading(false); push(); }
            else if (evt.type === "delta")   { current.statusText = ""; current.content += evt.text; current.rawAnswer = current.content; setLoading(false); push(); }
            else if (evt.type === "sources") { current.sources = evt.sources ?? []; push(); }
            else if (evt.type === "blocked") { current = { role: "assistant", status: "blocked", content: evt.message }; setLoading(false); push(); }
            else if (evt.type === "error")   { current = { role: "assistant", status: "error", content: evt.message }; setLoading(false); push(); }
            else if (evt.type === "done")    { if (evt.answer) { current.content = evt.answer; current.rawAnswer = evt.answer; } if (evt.message_id) current.messageId = evt.message_id; current.statusText = ""; push(); }
          }
        }
        if (!gotAnything) throw new Error("empty stream");
        return;
      }

      let aiMsg;
      if (data.status === "ok") {
        aiMsg = { role: "assistant", status: "ok", content: data.answer, rawAnswer: data.answer, sources: data.sources ?? [], audioBase64: data.audio_base64 ?? null, messageId: data.message_id ?? null };
        if (data.audio_base64) playBase64Audio(data.audio_base64);
      } else {
        aiMsg = { role: "assistant", status: data.status, content: data.message ?? "發生未知錯誤。" };
      }
      setMessages([...responseMessages, aiMsg]);
    } catch {
      setMessages([...responseMessages, { role: "assistant", status: "error", content: labels.connError }]);
    } finally {
      setLoading(false);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) { mediaRecorderRef.current?.stop(); setIsRecording(false); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const b64 = await fileToBase64(blob);
        sendMessage(labels.voiceLabel, true, b64);
      };
      recorder.start();
      setIsRecording(true);
    } catch { alert(labels.micError); }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleImageSelect(file);
  };

  const canSend = !loading && !isRecording && (!!input.trim() || !!imageBase64);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`relative flex h-full min-h-0 overflow-hidden ${T.root}${isDark ? " dark" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>

      {sidebarOpen && (
        <button
          type="button"
          aria-label={lang === "zh" ? "關閉側邊選單" : "Close sidebar"}
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── 左側 Sidebar ── */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(18rem,85vw)] shrink-0 flex-col border-r transition-transform duration-200 ease-out md:static md:z-auto md:w-64 md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${T.sidebar}`}
      >

        {/* NTPU AI Assistant 標題區 */}
        <div className={`p-4 border-b ${T.sidebarBorder}`}>
          <div className="mb-3 flex items-center gap-2.5">
            <NtpuLogo />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">{labels.title}</span>
            <button
              type="button"
              aria-label={lang === "zh" ? "關閉側邊選單" : "Close sidebar"}
              className={`rounded-lg p-2 transition-colors md:hidden ${T.sidebarBtn}`}
              onClick={() => setSidebarOpen(false)}
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={handleNewChat}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors font-medium ${T.sidebarBtn}`}
          >
            <PlusIcon className="w-4 h-4" />
            {labels.newChat}
          </button>
        </div>

        {/* 對話列表區 */}
        <div className="flex-1 overflow-y-auto p-3">
          {messages.length > 0 && (
            <div className={`px-3 py-2 text-xs rounded-lg truncate ${T.sidebarCurrent}`}>
              {messages.find(m => m.role === "user")?.content?.slice(0, 28) || "目前對話"}…
            </div>
          )}
        </div>

        {/* 底部設定按鈕（點擊展開） */}
        <div className={`border-t p-3 relative ${T.sidebarBorder}`} ref={settingsRef}>
          {/* 展開面板（向上彈出） */}
          {showSettings && (
            <div className={`absolute bottom-full left-3 right-3 mb-1 rounded-xl border shadow-lg overflow-hidden text-sm ${T.settingsPanel}`}>
              {/* 深淺色切換 */}
              <button
                onClick={() => { setIsDark(d => !d); setShowSettings(false); }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors ${T.settingsItem}`}
              >
                {isDark ? <SunIcon className="w-4 h-4 shrink-0" /> : <MoonIcon className="w-4 h-4 shrink-0" />}
                {isDark ? labels.lightMode : labels.darkMode}
              </button>

              <div className={`border-t ${T.settingsDivider}`} />

              {/* 語言切換 */}
              <button
                onClick={() => { setLang(l => l === "zh" ? "en" : "zh"); setShowSettings(false); }}
                className={`w-full flex items-center justify-between px-4 py-2.5 transition-colors ${T.settingsItem}`}
              >
                <span>{labels.langLabel}</span>
                <span className={T.sidebarMeta}>{lang === "zh" ? "中文" : "English"}</span>
              </button>
            </div>
          )}

          {/* 系統說明頁（public/about.html，另開分頁避免中斷對話） */}
          <a
            href="/about"
            target="_blank"
            rel="noopener noreferrer"
            title={labels.aboutTitle}
            onClick={() => setSidebarOpen(false)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${T.sidebarBtn}`}
          >
            <InfoIcon className="w-4 h-4 shrink-0" />
            <span className="min-w-0 truncate">{labels.about}</span>
            <ExternalLinkIcon className="w-3.5 h-3.5 ml-auto shrink-0 opacity-60" />
          </a>

          {/* 設定按鈕 */}
          <button
            onClick={() => setShowSettings(s => !s)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${T.sidebarBtn} ${showSettings ? T.sidebarCurrent : ""}`}
          >
            <SettingsIcon className="w-4 h-4" />
            {labels.settings}
          </button>
        </div>
      </aside>

      {/* ── 主內容區 ── */}
      <div className="flex min-w-0 flex-1 flex-col">

        {/* 頂部 Header（主內容區只顯示標題文字，logo 在 sidebar） */}
        <header className={`flex shrink-0 items-center gap-2.5 border-b px-3 py-3 sm:px-5 ${T.header}`}>
          <button
            type="button"
            aria-label={lang === "zh" ? "開啟側邊選單" : "Open sidebar"}
            aria-expanded={sidebarOpen}
            className={`rounded-lg p-2 transition-colors md:hidden ${T.sidebarBtn}`}
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <NtpuLogo />
          <span className={`min-w-0 truncate font-semibold ${T.headerText}`}>{labels.title}</span>
        </header>

        {/* 對話紀錄區 */}
        <main className={`flex-1 overflow-y-auto ${T.main}`}>
          {messages.length === 0 ? (
            /* 歡迎畫面 */
            <div className="flex min-h-full flex-col items-center justify-center gap-5 px-4 py-8 sm:gap-6 sm:px-6">
              <div className="min-w-0 max-w-full text-center">
                <h2 className={`text-xl font-semibold sm:text-2xl ${T.welcomeTitle}`}>{labels.welcome}</h2>
                <p className={`mt-2 break-words text-sm ${T.welcomeSub}`}>{labels.welcomeSub}</p>
                {/* 側邊欄在手機上收合，這裡再給一個顯眼的入口 */}
                <a
                  href="/about"
                  target="_blank"
                  rel="noopener noreferrer"
                  title={labels.aboutTitle}
                  className={`mt-3 inline-flex items-center gap-1.5 text-xs underline underline-offset-4 transition-opacity hover:opacity-100 opacity-75 ${T.welcomeSub}`}
                >
                  <InfoIcon className="w-3.5 h-3.5 shrink-0" />
                  {labels.about}
                  <ExternalLinkIcon className="w-3 h-3 shrink-0" />
                </a>
              </div>
              <div className="flex w-full max-w-xl flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
                {QUICK_QUESTIONS[lang].map((q, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(q)}
                    disabled={loading}
                    className={`w-full rounded-2xl border px-4 py-2 text-left text-sm transition-colors disabled:opacity-40 sm:w-auto sm:rounded-full sm:text-center ${T.quickBtn}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* 訊息列表 */
            <div className="mx-auto max-w-3xl px-3 py-4 sm:px-4 sm:py-6">
              {messages.map((msg, i) => (
                <MessageBubble key={i} msg={msg} lang={lang} T={T} sessionId={sessionId.current} />
              ))}
              {loading && <TypingIndicator T={T} />}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        {/* 底部輸入區 */}
        <footer className={`safe-bottom shrink-0 border-t px-2.5 pt-2 sm:px-4 sm:py-3 ${T.footer}`}>
          <div className="max-w-3xl mx-auto">
            {/* 圖片預覽 */}
            {imagePreview && (
              <div className="mb-2">
                <div className="relative inline-block">
                  <img src={imagePreview} alt="preview" className="h-16 rounded-lg border border-gray-300/40 object-cover" />
                  <button
                    onClick={clearImage}
                    className={`absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full text-xs flex items-center justify-center transition-colors ${T.clearBtnImg}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* 輸入列 */}
            <div className="flex items-end gap-1 sm:gap-2">
              {/* 圖片上傳 */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || isRecording}
                title={labels.uploadTitle}
                className={`p-2 shrink-0 transition-colors disabled:opacity-40 ${T.iconBtn}`}
              >
                <ImageIcon className="w-5 h-5" />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleImageSelect(e.target.files?.[0])} />

              {/* 語音 */}
              <button
                onClick={toggleRecording}
                disabled={loading}
                title={isRecording ? labels.recording : labels.voiceTitle}
                className={`p-2 shrink-0 transition-colors ${isRecording ? "text-red-500 animate-pulse" : `${T.iconBtn} disabled:opacity-40`}`}
              >
                <MicIcon className="w-5 h-5" />
              </button>

              {/* 文字輸入框 */}
              <textarea
                rows={1}
                className={`max-h-32 min-w-0 flex-1 resize-none rounded-xl border px-3 py-2.5 text-base leading-relaxed transition-colors focus:border-transparent focus:outline-none focus:ring-2 sm:text-sm ${T.inputBorder} ${T.inputBg} ${T.inputText} ${T.inputFocus} ${T.placeholder} ${loading || isRecording ? T.inputDisabled : ""}`}
                placeholder={isRecording ? labels.recording : labels.placeholder}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading || isRecording}
              />

              {/* 送出按鈕 */}
              <button
                onClick={() => sendMessage()}
                disabled={!canSend}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors shrink-0 ${canSend ? T.sendEnabled : T.sendDisabled}`}
                style={canSend ? { background: BRAND } : {}}
                onMouseEnter={e => { if (canSend) e.currentTarget.style.background = BRAND_HOVER; }}
                onMouseLeave={e => { if (canSend) e.currentTarget.style.background = BRAND; }}
              >
                <SendIcon className="w-4 h-4" />
              </button>
            </div>

            {/* 免責聲明 */}
            <p className={`mt-1.5 break-words px-1 text-center text-[10px] leading-tight sm:mt-2 sm:text-xs ${T.disclaimer}`}>{labels.disclaimer}</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
