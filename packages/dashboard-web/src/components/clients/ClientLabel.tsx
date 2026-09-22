import type { ClientApplication } from "@clankermux/types";
import { useClientApplications } from "../../hooks/queries";
import { ApplicationMarkIcon } from "./application-marks";
import { APPLICATIONS } from "./setup";

interface ClientLabelProps {
	/**
	 * The client's API key id. `null` for rows with no key (the unauthenticated
	 * bucket) and for labels that only ever had a name.
	 */
	apiKeyId: string | null | undefined;
	/** What to display. Identity is `apiKeyId`; this is only the label. */
	name: string;
	/**
	 * The harness, for callers that already hold it (anything with a
	 * `ClientView`). Omit it and the id is looked up instead. `null` means
	 * "known to have none".
	 */
	application?: ClientApplication | null;
	className?: string;
	iconClassName?: string;
}

/**
 * A client's name with the mark of the harness it is set up as.
 *
 * Two clients on one machine differ only by which harness they are — their
 * names carry a hand-written suffix to say so — and most of the dashboard has
 * no column to tell them apart. The mark is that column, in the width of an
 * icon.
 *
 * Passing `application` and omitting it take DIFFERENT code paths, because a
 * disabled `useQuery` still demands a `QueryClientProvider`: routing the known
 * case around the hook entirely is what lets a component tree that already
 * holds `ClientView`s render without one.
 */
export function ClientLabel({ application, ...props }: ClientLabelProps) {
	return application === undefined ? (
		<ResolvedClientLabel {...props} />
	) : (
		<Label {...props} application={application} />
	);
}

/** The id-only path: resolve the harness from the API-key list. */
function ResolvedClientLabel(props: Omit<ClientLabelProps, "application">) {
	const { data: applications } = useClientApplications();
	return (
		<Label
			{...props}
			application={
				props.apiKeyId ? (applications?.get(props.apiKeyId) ?? null) : null
			}
		/>
	);
}

function Label({
	name,
	application,
	className,
	iconClassName = "h-4 w-4",
}: Omit<ClientLabelProps, "application"> & {
	application: ClientApplication | null;
}) {
	return (
		<span
			className={`inline-flex min-w-0 items-center gap-1.5${
				className ? ` ${className}` : ""
			}`}
		>
			{/* No mark for an unknown harness. The terminal fallback is the answer
			    for `generic`, a harness the wizard offers, so drawing it here would
			    state something about a key the dashboard cannot see. */}
			{application !== null && (
				<ApplicationMarkIcon
					application={application}
					className={`shrink-0 ${iconClassName}`}
				/>
			)}
			<span className="truncate">{name}</span>
			{/* The mark is decorative, so without this the clients it separates are
			    still indistinguishable to a screen reader — the exact ambiguity the
			    mark exists to resolve. */}
			{application !== null && (
				<span className="sr-only"> ({APPLICATIONS[application]})</span>
			)}
		</span>
	);
}

/**
 * The same identification as plain text, for `<option>` elements and `title`
 * attributes, which cannot carry a mark.
 */
export function clientLabelText(
	name: string,
	application: ClientApplication | null | undefined,
): string {
	return application ? `${name} (${APPLICATIONS[application]})` : name;
}
