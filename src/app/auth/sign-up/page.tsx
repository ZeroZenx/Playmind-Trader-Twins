import Link from "next/link";
import { AuthForm } from "@/src/components/auth-form";

export default function SignUpPage() {
  return <main className="auth-shell"><div className="card auth-card"><div className="eyebrow">Start a workspace</div><h2>Create account</h2><p className="muted">Create a private pilot workspace. Add customer data only after the data contract is approved.</p><AuthForm mode="sign-up" /><p className="footer-note">Already have an account? <Link href="/auth/sign-in" style={{ color: "var(--forest)", fontWeight: 700 }}>Sign in</Link></p></div></main>;
}
