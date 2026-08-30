import RoomClient from "../../rooms/[roomId]/room-client";

export default async function SessionPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomClient roomId={roomId} />;
}
