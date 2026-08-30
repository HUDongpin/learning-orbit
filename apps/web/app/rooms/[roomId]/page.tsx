import { redirect } from "next/navigation";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  redirect(`/session/${roomId}`);
}
