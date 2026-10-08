"use client";

import { useId, useState } from "react";
import { Field, RequestState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export type SelectedUser = { id: string; name: string; email: string };
export const selectClassName =
	"flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Search the existing admin user endpoint and select an explicit account. */
export function UserPicker({
	value,
	onChange,
	disabled = false,
}: {
	value: SelectedUser | null;
	onChange: (user: SelectedUser | null) => void;
	disabled?: boolean;
}) {
	const id = useId();
	const [field, setField] = useState<"email" | "name">("email");
	const [text, setText] = useState("");
	const [search, setSearch] = useState({
		field: "email" as "email" | "name",
		text: "",
	});
	const [offset, setOffset] = useState(0);
	const result = useResource(JSON.stringify([search, offset]), () =>
		search.text
			? api(
					authClient.admin.listUsers({
						query: {
							searchField: search.field,
							searchValue: search.text,
							searchOperator: "contains",
							limit: 5,
							offset,
						},
					}),
				)
			: Promise.resolve(null),
	);
	return (
		<div className="space-y-3">
			{value && (
				<div className="flex items-start justify-between gap-3 rounded-md border p-3">
					<div className="min-w-0 space-y-1">
						<p className="truncate text-sm font-medium">{value.name}</p>
						<p className="break-all text-sm text-muted-foreground">
							{value.email}
						</p>
						<p className="break-all text-xs text-muted-foreground">
							ID：{value.id}
						</p>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={disabled}
						onClick={() => onChange(null)}
					>
						更换
					</Button>
				</div>
			)}
			{!value && (
				<>
					<div className="grid gap-3 sm:grid-cols-[7rem_1fr_auto] sm:items-end">
						<Field label="查找方式" htmlFor={`${id}-field`}>
							<select
								id={`${id}-field`}
								className={selectClassName}
								value={field}
								disabled={disabled}
								onChange={(event) =>
									setField(event.target.value === "name" ? "name" : "email")
								}
							>
								<option value="email">邮箱</option>
								<option value="name">姓名</option>
							</select>
						</Field>
						<Field label="查找用户" htmlFor={`${id}-search`}>
							<Input
								id={`${id}-search`}
								value={text}
								disabled={disabled}
								placeholder={
									field === "email" ? "输入用户邮箱" : "输入用户姓名"
								}
								onChange={(event) => setText(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										setOffset(0);
										setSearch({ field, text: text.trim() });
									}
								}}
							/>
						</Field>
						<Button
							type="button"
							variant="outline"
							disabled={disabled || !text.trim()}
							onClick={() => {
								setOffset(0);
								setSearch({ field, text: text.trim() });
							}}
						>
							搜索
						</Button>
					</div>
					{search.text && (
						<>
							<RequestState
								loading={result.loading}
								error={result.error}
								retry={result.reload}
								empty={result.data?.users.length === 0}
								message="未找到用户，请更换邮箱或姓名搜索。"
							/>
							{!result.loading &&
								!result.error &&
								result.data &&
								result.data.users.length > 0 && (
									<div className="divide-y rounded-md border">
										{result.data.users.map((user) => (
											<div
												key={user.id}
												className="flex items-center justify-between gap-3 p-3"
											>
												<div className="min-w-0">
													<p className="truncate text-sm font-medium">
														{user.name}
													</p>
													<p className="break-all text-sm text-muted-foreground">
														{user.email}
													</p>
												</div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													disabled={disabled}
													onClick={() => {
														onChange(user);
														setSearch({ field, text: "" });
													}}
												>
													选择
												</Button>
											</div>
										))}
									</div>
								)}
							{result.data && result.data.total > 5 && (
								<div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
									<p>共 {result.data.total} 位用户</p>
									<div className="flex gap-2">
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={disabled || result.loading || offset === 0}
											onClick={() => setOffset(Math.max(0, offset - 5))}
										>
											上一页
										</Button>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={
												disabled ||
												result.loading ||
												offset + 5 >= result.data.total
											}
											onClick={() => setOffset(offset + 5)}
										>
											下一页
										</Button>
									</div>
								</div>
							)}
						</>
					)}
				</>
			)}
		</div>
	);
}
