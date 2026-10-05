"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserWithRole } from "better-auth/plugins/admin";
import {
	ArrowDown,
	ArrowLeft,
	ArrowUpRight,
	BookOpen,
	Check,
	ChevronLeft,
	ChevronRight,
	CircleHelp,
	KeyRound,
	LayoutDashboard,
	Loader2,
	LockKeyhole,
	Menu,
	MoreHorizontal,
	Plus,
	RefreshCw,
	Search,
	Shield,
	ShieldCheck,
	ShieldOff,
	Trash2,
	UserCircle,
	Users,
	X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import "./admin.css";

const pageSize = 10;
const filters = {
	all: { label: "All users", query: {} },
	admin: {
		label: "Administrators",
		query: { filterField: "role", filterValue: "admin" },
	},
	banned: {
		label: "Suspended",
		query: { filterField: "banned", filterValue: true },
	},
};
type Filter = keyof typeof filters;

export default function Page() {
	const { data: session, isPending, error, refetch } = authClient.useSession();
	const router = useRouter();
	useEffect(() => {
		if (!isPending && !error && session?.user.role !== "admin")
			router.replace("/dashboard");
	}, [session, isPending, error, router]);
	if (error) {
		return (
			<div className="admin-app admin-gate" role="alert">
				<ShieldOff size={28} />
				<h1>Unable to verify your session</h1>
				<p>Please try again to access the admin console.</p>
				<button className="admin-button" onClick={() => refetch()}>
					Try again
				</button>
			</div>
		);
	}
	if (isPending || session?.user.role !== "admin") {
		return (
			<div className="admin-app admin-gate" role="status">
				<Loader2 className="animate-spin" size={24} />
				<span>Opening admin console…</span>
			</div>
		);
	}
	return <AdminDashboard currentUser={session.user} />;
}

function AdminDashboard({
	currentUser,
}: {
	currentUser: { id: string; name: string; email: string };
}) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const [mobileNav, setMobileNav] = useState(false);
	const dialogOpener = useRef<HTMLElement | null>(null);
	const directoryHeading = useRef<HTMLHeadingElement>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [search, setSearch] = useState("");
	const [searchValue, setSearchValue] = useState("");
	const [searchField, setSearchField] = useState<"email" | "name">("email");
	const [page, setPage] = useState(0);
	const [createOpen, setCreateOpen] = useState(false);
	const [selectedUser, setSelectedUser] = useState<UserWithRole | null>(null);
	const [dialog, setDialog] = useState<"suspend" | "delete" | null>(null);
	const [pending, setPending] = useState(false);
	const [reason, setReason] = useState("");
	const [expiration, setExpiration] = useState("");
	const [newUser, setNewUser] = useState({
		name: "",
		email: "",
		password: "",
		role: "user" as "user" | "admin",
	});

	useEffect(() => {
		const timeout = setTimeout(() => {
			setSearchValue(search.trim());
			setPage(0);
		}, 300);
		return () => clearTimeout(timeout);
	}, [search]);
	const users = useQuery({
		queryKey: [
			"admin",
			currentUser.id,
			"users",
			page,
			searchValue,
			searchField,
			filter,
		],
		queryFn: () =>
			authClient.admin.listUsers(
				{
					query: {
						limit: pageSize,
						offset: page * pageSize,
						sortBy: "createdAt",
						sortDirection: "desc",
						searchValue: searchValue || undefined,
						searchField,
						searchOperator: "contains",
						...filters[filter].query,
					},
				},
				{ throw: true },
			),
	});
	const stats = useQuery({
		queryKey: ["admin", currentUser.id, "stats"],
		queryFn: async () => {
			const results = await Promise.all(
				[
					{},
					{ filterField: "role", filterValue: "admin" },
					{ filterField: "emailVerified", filterValue: true },
					{ filterField: "banned", filterValue: true },
				].map((query) =>
					authClient.admin.listUsers(
						{ query: { limit: 1, ...query } },
						{ throw: true },
					),
				),
			);
			return results.map((result) => result.total);
		},
		staleTime: 30_000,
	});
	const total = users.data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	useEffect(() => {
		if (users.data && page >= totalPages) setPage(totalPages - 1);
	}, [users.data, page, totalPages]);

	async function runAction(
		action: () => Promise<{ error: { message?: string } | null }>,
		message: string,
		onSuccess?: () => void,
	) {
		setPending(true);
		try {
			const result = await action();
			if (result.error)
				throw new Error(
					result.error.message || "The request could not be completed.",
				);
			toast.success(message);
			onSuccess?.();
			await queryClient.invalidateQueries({
				queryKey: ["admin", currentUser.id],
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The request could not be completed. Please try again.",
			);
		} finally {
			setPending(false);
		}
	}
	function createUser(event: FormEvent) {
		event.preventDefault();
		void runAction(
			() => authClient.admin.createUser(newUser),
			"User created successfully",
			() => {
				setCreateOpen(false);
				setNewUser({ name: "", email: "", password: "", role: "user" });
				setPage(0);
			},
		);
	}
	function suspendUser(event: FormEvent) {
		event.preventDefault();
		if (!selectedUser) return;
		const seconds = Math.floor(
			(new Date(expiration).getTime() - Date.now()) / 1000,
		);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			toast.error("Choose a suspension end date in the future.");
			return;
		}
		void runAction(
			() =>
				authClient.admin.banUser({
					userId: selectedUser.id,
					banReason: reason,
					banExpiresIn: seconds,
				}),
			"User suspended successfully",
			() => setDialog(null),
		);
	}
	function changeFilter(value: Filter) {
		setFilter(value);
		setPage(0);
	}
	function clearFilters() {
		setSearch("");
		setSearchValue("");
		changeFilter("all");
	}
	function openCreate() {
		dialogOpener.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setCreateOpen(true);
	}
	function restoreFocus(event: Event) {
		event.preventDefault();
		const target = dialogOpener.current;
		if (target?.isConnected) target.focus();
		else directoryHeading.current?.focus();
	}
	const metrics = [
		{
			label: "Total users",
			description: "Across your application",
			icon: Users,
			tone: "mint",
		},
		{
			label: "Administrators",
			description: "With admin access",
			icon: Shield,
			tone: "blue",
		},
		{
			label: "Verified emails",
			description: "Email ownership confirmed",
			icon: ShieldCheck,
			tone: "mint",
		},
		{
			label: "Suspended users",
			description: "Access currently restricted",
			icon: ShieldOff,
			tone: "amber",
		},
	];
	return (
		<div className="admin-app">
			<a className="admin-skip" href="#users">
				Skip to users
			</a>
			<aside className="admin-sidebar">
				<Link href="/" className="admin-brand" aria-label="Better Auth home">
					<Logo />
					<span>
						better-auth<span className="admin-brand-dot">.</span>
					</span>
				</Link>
				<div className="admin-workspace">
					<div className="admin-workspace-icon">
						<KeyRound size={19} />
					</div>
					<div>
						<strong>Demo workspace</strong>
						<span>Admin console</span>
					</div>
					<span className="admin-workspace-tag">BA</span>
				</div>
				<div className="admin-nav-label">WORKSPACE</div>
				<nav aria-label="Admin navigation" className="admin-nav">
					<a href="#overview">
						<LayoutDashboard size={18} />
						Overview
					</a>
					<a href="#users" aria-current="page">
						<Users size={18} />
						User management
						<span className="admin-nav-count">
							{stats.data?.[0]?.toLocaleString() ?? "—"}
						</span>
					</a>
					<Link href="/dashboard">
						<UserCircle size={18} />
						My account
						<ArrowUpRight size={14} className="admin-nav-trailing" />
					</Link>
				</nav>
				<div className="admin-sidebar-bottom">
					<div className="admin-docs-card">
						<BookOpen size={20} />
						<strong>A little help, right here.</strong>
						<p>Everything you need to manage authentication with confidence.</p>
						<a
							href="https://www.better-auth.com/docs/plugins/admin"
							target="_blank"
							rel="noreferrer"
						>
							Read the admin guide
							<ArrowUpRight size={14} />
						</a>
					</div>
					<a
						className="admin-help"
						href="https://www.better-auth.com/docs"
						target="_blank"
						rel="noreferrer"
					>
						<CircleHelp size={17} />
						Documentation
						<ArrowUpRight size={14} />
					</a>
					<Link href="/dashboard" className="admin-account">
						<span className="admin-avatar admin-avatar-self">
							{currentUser.name.slice(0, 2).toUpperCase()}
						</span>
						<span>
							<strong>{currentUser.name}</strong>
							<small>Administrator</small>
						</span>
						<ChevronRight size={16} />
					</Link>
				</div>
			</aside>
			<div className="admin-main">
				<header className="admin-topbar">
					<button
						className="admin-icon-button admin-mobile-toggle"
						aria-label="Toggle navigation"
						aria-expanded={mobileNav}
						aria-controls="admin-mobile-nav"
						onClick={() => setMobileNav(!mobileNav)}
					>
						{mobileNav ? <X size={20} /> : <Menu size={20} />}
					</button>
					<div className="admin-breadcrumb">
						<span>Workspace</span>
						<ChevronRight size={14} />
						<strong>User management</strong>
					</div>
					<div className="admin-topbar-right">
						<span className="admin-access-label">
							<LockKeyhole size={13} />
							Admin access
						</span>
						<span
							className="admin-avatar admin-avatar-self"
							title={currentUser.email}
						>
							{currentUser.name.slice(0, 2).toUpperCase()}
						</span>
					</div>
				</header>
				{mobileNav && (
					<nav
						id="admin-mobile-nav"
						className="admin-mobile-nav"
						aria-label="Mobile admin navigation"
					>
						<a href="#overview" onClick={() => setMobileNav(false)}>
							Overview
						</a>
						<a href="#users" onClick={() => setMobileNav(false)}>
							User management
						</a>
						<Link href="/dashboard">My account</Link>
					</nav>
				)}
				<main className="admin-content">
					<section className="admin-heading" id="overview">
						<div>
							<div className="admin-eyebrow">YOUR WORKSPACE, AT A GLANCE</div>
							<h1>
								User management<span>.</span>
							</h1>
							<p>
								Manage your users, their roles, and access to your application.
							</p>
						</div>
						<button
							className="admin-button admin-button-primary"
							onClick={openCreate}
						>
							<Plus size={17} />
							Create user
						</button>
					</section>
					<section className="admin-metrics" aria-label="User overview">
						{metrics.map((metric, index) => (
							<div className="admin-metric" key={metric.label}>
								<div className="admin-metric-top">
									<span>{metric.label}</span>
									<metric.icon
										size={17}
										className={`admin-tone-${metric.tone}`}
									/>
								</div>
								<strong>
									{stats.isError
										? "—"
										: (stats.data?.[index]?.toLocaleString() ?? "…")}
								</strong>
								<div className="admin-metric-caption">
									<span className={`admin-dot admin-tone-${metric.tone}`} />
									{metric.description}
								</div>
							</div>
						))}
					</section>
					{stats.isError && (
						<div className="admin-inline-error" role="alert">
							Overview is temporarily unavailable.
							<button onClick={() => stats.refetch()}>Retry overview</button>
						</div>
					)}
					<section
						className="admin-panel"
						id="users"
						aria-labelledby="directory-title"
					>
						<div className="admin-panel-heading">
							<div>
								<h2 id="directory-title" ref={directoryHeading} tabIndex={-1}>
									User directory{" "}
									<span>{users.data ? total.toLocaleString() : "—"}</span>
								</h2>
								<p>A home for everyone in your application.</p>
							</div>
							<button
								className="admin-icon-button"
								aria-label="Refresh users"
								disabled={users.isFetching || stats.isFetching}
								onClick={() =>
									queryClient.invalidateQueries({
										queryKey: ["admin", currentUser.id],
									})
								}
							>
								<RefreshCw
									size={16}
									className={users.isFetching ? "animate-spin" : ""}
								/>
							</button>
						</div>
						<div className="admin-tabs" role="group" aria-label="Filter users">
							{(Object.keys(filters) as Filter[]).map((key) => (
								<button
									key={key}
									aria-pressed={filter === key}
									onClick={() => changeFilter(key)}
								>
									{filters[key].label}
									{key === "all" && stats.data && <span>{stats.data[0]}</span>}
								</button>
							))}
						</div>
						<div className="admin-toolbar">
							<div className="admin-search">
								<Search size={17} />
								<input
									aria-label="Search users"
									placeholder={`Search by ${searchField}…`}
									value={search}
									onChange={(event) => setSearch(event.target.value)}
								/>
								{search && (
									<button
										aria-label="Clear search"
										onClick={() => {
											setSearch("");
											setSearchValue("");
											setPage(0);
										}}
									>
										<X size={14} />
									</button>
								)}
							</div>
							<select
								className="admin-select"
								aria-label="Search field"
								value={searchField}
								onChange={(event) => {
									setSearchField(
										event.target.value === "name" ? "name" : "email",
									);
									setPage(0);
								}}
							>
								<option value="email">Email address</option>
								<option value="name">Name</option>
							</select>
							<span className="admin-sort">
								<ArrowDown size={14} />
								Newest first
							</span>
						</div>
						<div className="admin-table-scroll" aria-busy={users.isFetching}>
							<table className="admin-table">
								<caption className="sr-only">
									Application users, their access status and account actions
								</caption>
								<thead>
									<tr>
										<th>User</th>
										<th>Role</th>
										<th>Status</th>
										<th>Email verification</th>
										<th>
											Joined
											<ArrowDown size={12} />
										</th>
										<th>
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{users.isPending ? (
										<tr>
											<td colSpan={6}>
												<div className="admin-empty" role="status">
													<Loader2 className="animate-spin" size={24} />
													<strong>Loading users…</strong>
												</div>
											</td>
										</tr>
									) : users.isError ? (
										<tr>
											<td colSpan={6}>
												<div className="admin-empty" role="alert">
													<ShieldOff size={28} />
													<strong>Unable to load users</strong>
													<p>Please try again in a moment.</p>
													<button
														className="admin-button"
														onClick={() => users.refetch()}
													>
														Try again
													</button>
												</div>
											</td>
										</tr>
									) : !users.data?.users.length ? (
										<tr>
											<td colSpan={6}>
												<div className="admin-empty">
													<Search size={28} />
													<strong>No users found</strong>
													<p>
														{searchValue || filter !== "all"
															? "Try another search or clear your filters."
															: "Create your first user to get started."}
													</p>
													<button
														className="admin-button"
														onClick={
															searchValue || filter !== "all"
																? clearFilters
																: openCreate
														}
													>
														{searchValue || filter !== "all"
															? "Clear filters"
															: "Create your first user"}
													</button>
												</div>
											</td>
										</tr>
									) : (
										users.data.users.map((user, index) => (
											<tr key={user.id}>
												<td>
													<div className="admin-user">
														<span
															className={`admin-avatar admin-avatar-${index % 4}`}
														>
															{user.name.slice(0, 2).toUpperCase() || "U"}
														</span>
														<div>
															<strong>
																{user.name || "Unnamed user"}
																{user.id === currentUser.id && (
																	<span className="admin-you">you</span>
																)}
															</strong>
															<span>{user.email}</span>
														</div>
													</div>
												</td>
												<td>
													<span className="admin-role">
														{user.role === "admin" && <Shield size={12} />}
														{user.role || "user"}
													</span>
												</td>
												<td>
													<span
														className={`admin-status ${user.banned ? "is-suspended" : "is-active"}`}
													>
														<span />
														{user.banned ? "Suspended" : "Active"}
													</span>
												</td>
												<td>
													<span
														className={`admin-verification ${user.emailVerified ? "is-verified" : ""}`}
													>
														{user.emailVerified ? (
															<Check size={14} />
														) : (
															<span className="admin-unverified-dot" />
														)}
														{user.emailVerified ? "Verified" : "Unverified"}
													</span>
												</td>
												<td className="admin-date">
													{new Intl.DateTimeFormat("en-US", {
														month: "short",
														day: "numeric",
														year: "numeric",
													}).format(new Date(user.createdAt))}
												</td>
												<td>
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<button
																className="admin-icon-button"
																aria-label={`Actions for ${user.email}`}
																onPointerDown={(event) => {
																	dialogOpener.current = event.currentTarget;
																}}
																onFocus={(event) => {
																	dialogOpener.current = event.currentTarget;
																}}
																disabled={pending}
															>
																<MoreHorizontal size={18} />
															</button>
														</DropdownMenuTrigger>
														<DropdownMenuContent
															align="end"
															className="admin-menu"
														>
															<DropdownMenuItem
																onSelect={() =>
																	runAction(
																		() =>
																			authClient.admin.impersonateUser({
																				userId: user.id,
																			}),
																		"Impersonating user",
																		() => router.push("/dashboard"),
																	)
																}
															>
																<UserCircle />
																Impersonate user
															</DropdownMenuItem>
															<DropdownMenuItem
																onSelect={() =>
																	runAction(
																		() =>
																			authClient.admin.revokeUserSessions({
																				userId: user.id,
																			}),
																		"Sessions revoked successfully",
																	)
																}
															>
																<RefreshCw />
																Revoke sessions
															</DropdownMenuItem>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																onSelect={() => {
																	if (user.banned) {
																		void runAction(
																			() =>
																				authClient.admin.unbanUser({
																					userId: user.id,
																				}),
																			"User access restored",
																		);
																	} else {
																		setSelectedUser(user);
																		setReason("");
																		setExpiration("");
																		setDialog("suspend");
																	}
																}}
															>
																<ShieldOff />
																{user.banned
																	? "Restore access"
																	: "Suspend user"}
															</DropdownMenuItem>
															<DropdownMenuItem
																className="admin-menu-danger"
																onSelect={() => {
																	setSelectedUser(user);
																	setDialog("delete");
																}}
															>
																<Trash2 />
																Delete user
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</td>
											</tr>
										))
									)}
								</tbody>
							</table>
						</div>
						<footer className="admin-pagination">
							<span aria-live="polite">
								{users.data && !users.isError ? (
									total ? (
										<>
											Showing{" "}
											<strong>
												{page * pageSize + 1}–
												{Math.min((page + 1) * pageSize, total)}
											</strong>{" "}
											of <strong>{total.toLocaleString()}</strong> users
										</>
									) : (
										"0 users"
									)
								) : (
									"— users"
								)}
							</span>
							<div>
								<span>
									Page {page + 1} of {totalPages}
								</span>
								<button
									className="admin-icon-button"
									aria-label="Previous page"
									disabled={page === 0 || users.isFetching}
									onClick={() => setPage(page - 1)}
								>
									<ChevronLeft size={16} />
								</button>
								<button
									className="admin-icon-button"
									aria-label="Next page"
									disabled={page + 1 >= totalPages || users.isFetching}
									onClick={() => setPage(page + 1)}
								>
									<ChevronRight size={16} />
								</button>
							</div>
						</footer>
					</section>
					<div className="admin-security-note">
						<ShieldCheck size={17} />
						<p>
							<strong>Access stays in your control.</strong> Suspending a user
							revokes their sessions and prevents them from signing in.
						</p>
						<a
							href="https://www.better-auth.com/docs/plugins/admin#ban-user"
							target="_blank"
							rel="noreferrer"
						>
							Learn more
							<ArrowUpRight size={14} />
						</a>
					</div>
					<footer className="admin-page-footer">
						<span>Authentication, made better.</span>
						<Link href="/dashboard">
							<ArrowLeft size={13} />
							Back to your account
						</Link>
					</footer>
				</main>
			</div>
			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					if (!pending) setCreateOpen(open);
				}}
			>
				<DialogContent className="admin-dialog" onCloseAutoFocus={restoreFocus}>
					<DialogHeader>
						<DialogTitle>Create user</DialogTitle>
						<DialogDescription>
							Add a new account to your application.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={createUser} className="admin-form">
						<label htmlFor="new-name">
							Name
							<input
								id="new-name"
								autoComplete="name"
								required
								value={newUser.name}
								onChange={(event) =>
									setNewUser({ ...newUser, name: event.target.value })
								}
								placeholder="Alex Morgan"
							/>
						</label>
						<label htmlFor="new-email">
							Email
							<input
								id="new-email"
								type="email"
								autoComplete="email"
								required
								value={newUser.email}
								onChange={(event) =>
									setNewUser({ ...newUser, email: event.target.value })
								}
								placeholder="alex@company.com"
							/>
						</label>
						<label htmlFor="new-password">
							Password
							<input
								id="new-password"
								type="password"
								autoComplete="new-password"
								minLength={8}
								required
								value={newUser.password}
								onChange={(event) =>
									setNewUser({ ...newUser, password: event.target.value })
								}
								placeholder="At least 8 characters"
							/>
						</label>
						<label htmlFor="new-role">
							Role
							<select
								id="new-role"
								value={newUser.role}
								onChange={(event) =>
									setNewUser({
										...newUser,
										role: event.target.value === "admin" ? "admin" : "user",
									})
								}
							>
								<option value="user">User</option>
								<option value="admin">Admin</option>
							</select>
						</label>
						<div className="admin-form-actions">
							<button
								type="button"
								className="admin-button"
								disabled={pending}
								onClick={() => setCreateOpen(false)}
							>
								Cancel
							</button>
							<button
								type="submit"
								className="admin-button admin-button-primary"
								disabled={pending}
							>
								{pending && <Loader2 size={15} className="animate-spin" />}
								Create user
							</button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog
				open={dialog !== null}
				onOpenChange={(open) => {
					if (!open && !pending) setDialog(null);
				}}
			>
				<DialogContent className="admin-dialog" onCloseAutoFocus={restoreFocus}>
					<DialogHeader>
						<DialogTitle>
							{dialog === "delete" ? "Delete user" : "Suspend user"}
						</DialogTitle>
						<DialogDescription>
							{dialog === "delete"
								? `Permanently delete ${selectedUser?.email} and their account data? This cannot be undone.`
								: `Temporarily restrict access for ${selectedUser?.email}. Their active sessions will be revoked.`}
						</DialogDescription>
					</DialogHeader>
					{dialog === "suspend" ? (
						<form className="admin-form" onSubmit={suspendUser}>
							<label htmlFor="ban-reason">
								Reason
								<input
									id="ban-reason"
									value={reason}
									onChange={(event) => setReason(event.target.value)}
									required
									placeholder="Explain why access is being suspended"
								/>
							</label>
							<label htmlFor="ban-expiration">
								Suspend until
								<input
									id="ban-expiration"
									type="datetime-local"
									value={expiration}
									onChange={(event) => setExpiration(event.target.value)}
									required
								/>
							</label>
							<div className="admin-form-actions">
								<button
									type="button"
									className="admin-button"
									disabled={pending}
									onClick={() => setDialog(null)}
								>
									Cancel
								</button>
								<button
									className="admin-button admin-button-danger"
									type="submit"
									disabled={pending}
								>
									{pending && <Loader2 size={15} className="animate-spin" />}
									Suspend user
								</button>
							</div>
						</form>
					) : (
						<div className="admin-form-actions">
							<button
								className="admin-button"
								disabled={pending}
								onClick={() => setDialog(null)}
							>
								Cancel
							</button>
							<button
								className="admin-button admin-button-danger"
								disabled={pending}
								onClick={() => {
									if (selectedUser)
										void runAction(
											() =>
												authClient.admin.removeUser({
													userId: selectedUser.id,
												}),
											"User deleted successfully",
											() => {
												dialogOpener.current = directoryHeading.current;
												setDialog(null);
											},
										);
								}}
							>
								{pending && <Loader2 size={15} className="animate-spin" />}
								Delete user
							</button>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
