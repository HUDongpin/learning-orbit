import { notFound, permanentRedirect } from "next/navigation";

import { isRoomId, roomPagePath } from "../../../src/lib/session/room-route";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  if (!isRoomId(roomId)) notFound();
  permanentRedirect(roomPagePath(roomId, "student"));
}
