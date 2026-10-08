"use client";

import type { Product } from "@app/auth-sdk/subscription";
import { Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Field, Notice, Pagination, RequestState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, useOperation, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate, money, parsePrice, priceInput } from "@/lib/format";

const labels = { credits: "积分包", membership: "会员", bundle: "会员＋积分" };
const selectStyle =
	"h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";
const blank = () => ({
	key: "",
	name: "",
	type: "membership" as Product["type"],
	price: "",
	currency: "USD",
	credits: "",
	membershipDays: "30",
	creditValidityDays: "",
	limits: "{}",
	published: false,
	reason: "",
});

/** Manage immutable catalog versions through the existing business plugin. */
export function ProductsPanel() {
	const [offset, setOffset] = useState(0);
	const limit = 20;
	const catalog = useResource(`products:${offset}`, () =>
		api(authClient.business.admin.products({ query: { limit, offset } })),
	);
	const [editor, setEditor] = useState<Product | null | undefined>(undefined);
	const [form, setForm] = useState(blank);
	const [publish, setPublish] = useState<Product | null>(null);
	const [publishReason, setPublishReason] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	const operation = useOperation();
	const publication = useOperation();
	function edit(product: Product | null) {
		setError("");
		setSuccess("");
		setEditor(product);
		setForm(
			product
				? {
						key: product.key,
						name: product.name,
						type: product.type,
						price: priceInput(product.amount, product.currency),
						currency: product.currency,
						credits: String(product.credits),
						membershipDays:
							product.membershipDays === null
								? ""
								: String(product.membershipDays),
						creditValidityDays:
							product.creditValidityDays === null
								? ""
								: String(product.creditValidityDays),
						limits: JSON.stringify(product.limits, null, 2),
						published: product.published,
						reason: "",
					}
				: blank(),
		);
	}
	function changeType(type: string) {
		if (type !== "credits" && type !== "membership" && type !== "bundle")
			return;
		setForm((value) => ({
			...value,
			type,
			credits: type === "membership" ? "" : value.credits || "100",
			membershipDays: type === "credits" ? "" : value.membershipDays || "30",
			creditValidityDays: type === "membership" ? "" : value.creditValidityDays,
			limits: type === "credits" ? "{}" : value.limits,
		}));
	}
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		setSuccess("");
		setPending(true);
		try {
			if (!form.reason.trim()) throw new Error("请填写本次操作的原因。");
			if (!form.name.trim()) throw new Error("请填写套餐名称。");
			let limits: unknown;
			try {
				limits = JSON.parse(form.limits);
			} catch {
				throw new Error("会员权益不是有效的 JSON，请检查引号、逗号和括号。");
			}
			if (!limits || typeof limits !== "object" || Array.isArray(limits))
				throw new Error('权益配置必须是 JSON 对象，例如 {"exports": true}。');
			const number = (
				text: string,
				label: string,
				maximum = Number.MAX_SAFE_INTEGER,
			) => {
				const value = Number(text);
				if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
					throw new Error(
						`${label}请输入 1 到 ${maximum.toLocaleString()} 的整数。`,
					);
				return value;
			};
			const currency = form.currency.trim().toUpperCase();
			const product = {
				key: form.key.trim(),
				name: form.name.trim(),
				type: form.type,
				amount: parsePrice(form.price, currency),
				currency,
				credits:
					form.type === "membership" ? 0 : number(form.credits, "积分数量"),
				membershipDays:
					form.type === "credits"
						? null
						: number(form.membershipDays, "会员天数", 36_500),
				creditValidityDays:
					form.type === "membership" || !form.creditValidityDays
						? null
						: number(form.creditValidityDays, "积分有效天数", 36_500),
				limits: limits as Product["limits"],
				published: form.published,
				expectedVersion: editor?.version ?? 0,
			};
			const payload = { product, reason: form.reason.trim() };
			await api(
				authClient.business.admin.products.save({
					...payload,
					operationId: operation.key(payload),
				}),
			);
			operation.reset();
			setEditor(undefined);
			setSuccess(
				`“${product.name}”已保存${product.published ? "并上架" : "为下架状态"}。`,
			);
			catalog.reload();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	}
	async function changePublication(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!publish) return;
		setPending(true);
		setError("");
		try {
			if (!publishReason.trim()) throw new Error("请填写本次操作的原因。");
			const payload = {
				key: publish.key,
				expectedVersion: publish.version,
				published: !publish.published,
				reason: publishReason.trim(),
			};
			await api(
				authClient.business.admin.products.publish({
					...payload,
					operationId: publication.key(payload),
				}),
			);
			publication.reset();
			setPublish(null);
			setSuccess(`“${publish.name}”已${publish.published ? "下架" : "上架"}。`);
			catalog.reload();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-xl font-semibold tracking-tight">套餐管理</h2>
				<Button disabled={pending} onClick={() => edit(null)}>
					<Plus className="h-4 w-4" aria-hidden="true" />
					新增套餐
				</Button>
			</div>
			<Notice message={success} kind="success" />
			{editor !== undefined && (
				<Card>
					<CardHeader>
						<CardTitle>{editor ? "编辑套餐" : "新增套餐"}</CardTitle>
						<CardDescription>
							{editor
								? `当前版本 v${editor.version}；保存后生成新版本，已购买的权益保持不变。`
								: "选择积分包、会员或组合套餐，并设置购买后获得的权益。"}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form onSubmit={save} className="space-y-4">
							<fieldset disabled={pending} className="space-y-4">
								<div className="grid gap-4 sm:grid-cols-2">
									<Field
										label="套餐标识"
										htmlFor="product-key"
										hint="小写字母、数字、下划线或短横线；创建后不可修改。"
									>
										<Input
											id="product-key"
											required
											pattern="[a-z0-9][a-z0-9_-]*"
											maxLength={100}
											disabled={!!editor}
											value={form.key}
											onChange={(event) =>
												setForm({ ...form, key: event.target.value })
											}
											autoFocus={!editor}
										/>
									</Field>
									<Field label="套餐名称" htmlFor="product-name">
										<Input
											id="product-name"
											required
											maxLength={255}
											value={form.name}
											onChange={(event) =>
												setForm({ ...form, name: event.target.value })
											}
											autoFocus={!!editor}
										/>
									</Field>
									<Field label="套餐类型" htmlFor="product-type">
										<select
											id="product-type"
											className={selectStyle}
											value={form.type}
											onChange={(event) => changeType(event.target.value)}
										>
											<option value="membership">会员</option>
											<option value="credits">积分包</option>
											<option value="bundle">会员＋积分</option>
										</select>
									</Field>
									<Field label="上架状态" htmlFor="product-published">
										<select
											id="product-published"
											className={selectStyle}
											value={String(form.published)}
											onChange={(event) =>
												setForm({
													...form,
													published: event.target.value === "true",
												})
											}
										>
											<option value="false">下架 · 暂不接受新购买</option>
											<option value="true">上架 · 接受新购买</option>
										</select>
									</Field>
									<Field
										label="价格"
										htmlFor="product-price"
										hint="填写货币金额，例如 USD 9.99；按币种精度保存。"
									>
										<Input
											id="product-price"
											required
											inputMode="decimal"
											value={form.price}
											onChange={(event) =>
												setForm({ ...form, price: event.target.value })
											}
										/>
									</Field>
									<Field label="币种" htmlFor="product-currency">
										<Input
											id="product-currency"
											required
											minLength={3}
											maxLength={3}
											pattern="[A-Za-z]{3}"
											value={form.currency}
											onChange={(event) =>
												setForm({
													...form,
													currency: event.target.value.toUpperCase(),
												})
											}
										/>
									</Field>
									{form.type !== "credits" && (
										<Field label="会员天数" htmlFor="product-days">
											<Input
												id="product-days"
												type="number"
												min={1}
												max={36_500}
												step={1}
												required
												value={form.membershipDays}
												onChange={(event) =>
													setForm({
														...form,
														membershipDays: event.target.value,
													})
												}
											/>
										</Field>
									)}
									{form.type !== "membership" && (
										<>
											<Field label="到账积分" htmlFor="product-credits">
												<Input
													id="product-credits"
													type="number"
													min={1}
													step={1}
													required
													value={form.credits}
													onChange={(event) =>
														setForm({ ...form, credits: event.target.value })
													}
												/>
											</Field>
											<Field
												label="积分有效天数"
												htmlFor="product-validity"
												hint="留空表示永久有效；从付款日期开始计算。"
											>
												<Input
													id="product-validity"
													type="number"
													min={1}
													max={36_500}
													step={1}
													value={form.creditValidityDays}
													onChange={(event) =>
														setForm({
															...form,
															creditValidityDays: event.target.value,
														})
													}
												/>
											</Field>
										</>
									)}
								</div>
								{form.type !== "credits" && (
									<Field
										label="会员权益 JSON"
										htmlFor="product-limits"
										hint="按网站约定填写权益，例如 {&quot;exports&quot;: true}。"
									>
										<Textarea
											id="product-limits"
											required
											rows={4}
											spellCheck={false}
											className="font-mono text-xs"
											value={form.limits}
											onChange={(event) =>
												setForm({ ...form, limits: event.target.value })
											}
										/>
									</Field>
								)}
								<Field label="操作原因" htmlFor="product-reason">
									<Textarea
										id="product-reason"
										required
										maxLength={500}
										rows={2}
										value={form.reason}
										onChange={(event) =>
											setForm({ ...form, reason: event.target.value })
										}
									/>
								</Field>
								<Notice message={error} />
								<div className="flex flex-wrap justify-end gap-2">
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											setEditor(undefined);
											setError("");
										}}
									>
										取消
									</Button>
									<Button type="submit">
										{pending ? "正在保存…" : "保存套餐"}
									</Button>
								</div>
							</fieldset>
						</form>
					</CardContent>
				</Card>
			)}
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="space-y-1.5">
							<CardTitle>全部套餐</CardTitle>
							<CardDescription>
								展示每个套餐的最新版本。下架不会影响已购买的会员和积分。
							</CardDescription>
						</div>
						<Button
							variant="outline"
							disabled={catalog.loading || pending}
							onClick={catalog.reload}
						>
							刷新
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<RequestState
						{...catalog}
						retry={catalog.reload}
						empty={catalog.data?.length === 0}
						message="暂无套餐。新增第一个套餐后即可配置销售内容。"
					/>
					{catalog.data && catalog.data.length > 0 && (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>套餐</TableHead>
									<TableHead>类型与权益</TableHead>
									<TableHead>价格</TableHead>
									<TableHead>状态</TableHead>
									<TableHead>更新日期</TableHead>
									<TableHead className="text-right">操作</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{catalog.data.map((product) => (
									<TableRow key={product.id}>
										<TableCell>
											<p className="font-medium">{product.name}</p>
											<p className="text-xs text-muted-foreground">
												{product.key} · v{product.version}
											</p>
										</TableCell>
										<TableCell>
											<p>{labels[product.type]}</p>
											<p className="text-xs text-muted-foreground">
												{product.membershipDays
													? `${product.membershipDays} 天会员`
													: ""}
												{product.membershipDays && product.credits ? " · " : ""}
												{product.credits
													? `${product.credits.toLocaleString()} 积分`
													: ""}
											</p>
											{product.credits > 0 && (
												<p className="text-xs text-muted-foreground">
													{product.creditValidityDays
														? `积分 ${product.creditValidityDays} 天有效`
														: "积分永久有效"}
												</p>
											)}
										</TableCell>
										<TableCell className="whitespace-nowrap tabular-nums">
											{money(product.amount, product.currency)}
										</TableCell>
										<TableCell>
											<Badge
												variant={product.published ? "default" : "secondary"}
											>
												{product.published ? "已上架" : "已下架"}
											</Badge>
										</TableCell>
										<TableCell className="whitespace-nowrap text-muted-foreground">
											{formatDate(product.createdAt)}
										</TableCell>
										<TableCell>
											<div className="flex justify-end gap-1">
												<Button
													variant="ghost"
													size="sm"
													disabled={pending}
													onClick={() => edit(product)}
												>
													编辑<span className="sr-only">{product.name}</span>
												</Button>
												<Button
													variant="outline"
													size="sm"
													disabled={pending}
													onClick={() => {
														setPublish(product);
														setPublishReason("");
														setError("");
														setSuccess("");
													}}
												>
													{product.published ? "下架" : "上架"}
													<span className="sr-only">{product.name}</span>
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{catalog.data && (
						<Pagination
							offset={offset}
							limit={limit}
							hasMore={catalog.data.length === limit}
							onChange={setOffset}
						/>
					)}
				</CardContent>
			</Card>
			<Dialog
				open={!!publish}
				onOpenChange={(open) => {
					if (!open && !pending) {
						setPublish(null);
						setError("");
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{publish?.published ? "下架套餐" : "上架套餐"}
						</DialogTitle>
						<DialogDescription>
							{publish?.name} · 当前 v{publish?.version}
							。此次操作会生成新版本，已购买权益保持不变。
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={changePublication} className="space-y-4">
						<Field label="操作原因" htmlFor="publish-reason">
							<Textarea
								id="publish-reason"
								required
								rows={3}
								maxLength={500}
								disabled={pending}
								value={publishReason}
								onChange={(event) => setPublishReason(event.target.value)}
							/>
						</Field>
						<Notice message={error} />
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={() => setPublish(null)}
							>
								取消
							</Button>
							<Button type="submit" disabled={pending}>
								{pending
									? "正在提交…"
									: `确认${publish?.published ? "下架" : "上架"}`}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
