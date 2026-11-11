import Link from "next/link";

export function Landing() {
  return (
    <main className="content" style={{ maxWidth: 1280, margin: "0 auto" }}>
      <div className="brand"><span className="brand-mark">P</span><span className="brand-copy">PlayMind Trader Twins</span></div>
      <section className="hero-grid" style={{ marginTop: 34 }}>
        <div className="hero-card">
          <div><div className="eyebrow">Responsible-trading intelligence</div><h1>Test policy ideas before they touch a live venue.</h1><p className="lede">PlayMind turns tokenized trader histories into transparent behavioral twins, then compares baseline and policy scenarios in an auditable workspace.</p></div>
          <div className="button-row"><Link className="button" href="/auth/sign-up">Start a workspace</Link><Link className="button secondary" href="/auth/sign-in">Sign in</Link></div>
        </div>
        <div className="hero-art"><div className="art-grid" /><div className="art-copy"><div className="art-kicker">Evidence before action</div><div className="art-number">01</div><p>One venue. One tokenized batch. One policy question. One evidence report.</p></div></div>
      </section>
      <section className="grid-3" style={{ marginTop: 24 }}>
        <div className="card"><div className="eyebrow">Data boundary</div><h3>Tokenized by design</h3><p className="muted">Direct PII rejection, workspace isolation, source checksums, and audit records sit at the intake boundary.</p></div>
        <div className="card"><div className="eyebrow">Twin method</div><h3>Transparent baseline</h3><p className="muted">Versioned aggregate behavior models store seeds, windows, coverage, and limitations.</p></div>
        <div className="card"><div className="eyebrow">Action</div><h3>Read-only venue layer</h3><p className="muted">The first release produces evidence. It does not place orders, manage funds, or route trades.</p></div>
      </section>
      <p className="footer-note">Synthetic results stay labeled as synthetic. Customer evidence requires an approved data contract and reviewer approval.</p>
    </main>
  );
}
