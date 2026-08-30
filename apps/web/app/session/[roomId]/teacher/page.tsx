import { notFound } from "next/navigation";

import { isRoomId } from "../../../../src/lib/session/room-route";
import { RoomAccessClient } from "../room-access-client";

export default async function TeacherRoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  if (!isRoomId(roomId)) notFound();
  return <RoomAccessClient mode="teacher" roomId={roomId} />;
}
