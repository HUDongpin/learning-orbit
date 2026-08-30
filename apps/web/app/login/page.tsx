import { LoginClient } from "./login-client";

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ role?: string | string[] }> }>) {
  const query = await searchParams;
  return <LoginClient initialRole={query.role === "teacher" ? "teacher" : "student"} />;
}
