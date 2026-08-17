export type SourceAdmissionMode = 'compatibility' | 'durable';

// A CMS build predating mode exposure is necessarily the compatibility side
// of the cutover. CMS still owns the final mutation guard, so a mixed-version
// deployment cannot create work through both producers.
export function sourceAdmissionMode(policy: { source_run_admission_mode?: SourceAdmissionMode }): SourceAdmissionMode {
	return policy.source_run_admission_mode ?? 'compatibility';
}
