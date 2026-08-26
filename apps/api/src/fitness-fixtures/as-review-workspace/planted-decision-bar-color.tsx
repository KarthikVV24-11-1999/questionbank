// Planted violation for frontend-rules.spec.ts (F24), M4-42's own row.
//
// The decision bar is where a colour literal is most tempting and most
// harmful: approve/reject wants green/red, and a hand-picked green is a
// contrast ratio nobody checked, on the one control a reviewer uses hundreds
// of times an hour. §9 rule 16 says the token layer owns the value; this
// fixture is that rule broken in the exact place M4-39 would break it.
export function DecisionBarOutcomeButton(): string {
  return '<button style="background-color: #1a7f37">Approve</button>';
}
