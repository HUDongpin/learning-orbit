import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RoomClient from "./room-client";

describe("Learning Orbit room client", () => {
  afterEach(() => cleanup());
  it("sends a local prompt and exposes the updated evidence/list views", () => {
    render(<RoomClient roomId="demo-room" />);
    const input = screen.getByRole("textbox", { name: "分享觀察、證據或一個問題…" });
    fireEvent.change(input, { target: { value: "能量沿食物鏈傳遞 @Nova" } });
    fireEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(screen.getByText("能量沿食物鏈傳遞 @Nova")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "來源歸因" }));
    expect(screen.getByRole("group", { name: /lineage_adjusted/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Nova Agent 促進 探索者 D/ })[0]).toBeInTheDocument();
  });

  it("supports reply context and truthful media/recording labels", () => {
    render(<RoomClient roomId="demo-room" />);
    fireEvent.click(screen.getAllByRole("button", { name: "回覆 探索者 A" })[0]!);
    expect(screen.getByText(/回覆 探索者 A/)).toBeInTheDocument();
    expect(screen.getAllByTitle("選擇圖片（本地演示）")[0]).toBeInTheDocument();
    expect(screen.getAllByTitle("錄製語音（本地演示）")[0]).toBeInTheDocument();
  });
});
