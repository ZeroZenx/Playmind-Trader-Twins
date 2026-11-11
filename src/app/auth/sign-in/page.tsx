import Link from "next/link";
import { AuthForm } from "@/src/components/auth-form";

export default function SignInPage() {
  return <main className="auth-shell"><div className="card auth-card"><div className="eyebrow">PlayMind workspace</div><h2>Sign in</h2><p className="muted">Use your workspace account to review datasets, experiments, and evidence reports.</p><AuthForm mode="sign-in" /><p className="footer-note">New to PlayMind? <Link href="/auth/sign-up" style={{ color: "var(--forest)", fontWeight: 700 }}>Create an account</Link></p></div></main>;
}
