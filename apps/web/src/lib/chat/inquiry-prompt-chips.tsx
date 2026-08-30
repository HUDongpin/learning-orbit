"use client";

import React from "react";

const PROMPTS = [
  ["描述觀察證據", "我觀察到的證據是："],
  ["追問物質循環", "我想追問：分解者怎樣讓物質回到環境？"],
  ["連結同伴觀點", "我想連結一位同學的觀點："],
  ["提出不同解釋", "另一個可能的解釋是："],
] as const;

export function InquiryPromptChips({ onInsert, disabled = false }: Readonly<{ onInsert(prompt: string): void; disabled?: boolean }>) {
  return (
    <div className="chips" aria-label="探究提問提示">
      {PROMPTS.map(([label, prompt]) => (
        <button className="chip" disabled={disabled} key={label} onClick={() => onInsert(prompt)} type="button" aria-label={`使用提示：${label}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
