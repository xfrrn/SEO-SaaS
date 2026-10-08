import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageSDK } from "./pack-sdk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("independently installed SDKs deliver to the real Collector with restart recovery", {
	timeout: 180_000,
}, async (t) => {
	assert.ok(
		process.env.MONITOR_COLLECTOR_PATH,
		"Set MONITOR_COLLECTOR_PATH to the independent Collector directory",
	);
	const temporaryRoot = resolve(tmpdir());
	const directory = await mkdtemp(
		join(temporaryRoot, "auth-monitor-consumer-"),
	);
	t.after(async () => {
		assert.equal(dirname(resolve(directory)), temporaryRoot);
		await rm(directory, { recursive: true, force: true });
	});
	function pnpm(cwd, args) {
		assert.match(process.env.npm_execpath ?? "", /pnpm\.(?:c?js|mjs)$/);
		const result = spawnSync(
			process.execPath,
			[process.env.npm_execpath, ...args],
			{ cwd, encoding: "utf8", timeout: 120_000 },
		);
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	}
	const stage = join(directory, "stage");
	const consumer = join(directory, "consumer");
	await stageSDK(root, stage);
	pnpm(stage, ["pack", "--out", "auth-sdk.tgz"]);
	await mkdir(join(consumer, "vendor"), { recursive: true });
	await cp(
		join(stage, "auth-sdk.tgz"),
		join(consumer, "vendor", "auth-sdk.tgz"),
	);
	await cp(
		join(root, "vendor", "monitor-analytics-sdk-0.1.1.tgz"),
		join(consumer, "vendor", "monitor-analytics-sdk-0.1.1.tgz"),
	);
	await writeFile(
		join(consumer, "pnpm-workspace.yaml"),
		"packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\n",
	);
	await writeFile(
		join(consumer, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: {
				"@app/auth-sdk": "file:./vendor/auth-sdk.tgz",
				"monitor-analytics-sdk":
					"file:./vendor/monitor-analytics-sdk-0.1.1.tgz",
			},
		}),
	);
	pnpm(consumer, ["install", "--ignore-scripts", "--prefer-offline"]);
	// The consumer imports both archives after the staging checkout is removed.
	assert.equal(dirname(resolve(stage)), directory);
	await rm(stage, { recursive: true, force: true });
	const manifest = JSON.parse(
		await readFile(
			join(consumer, "node_modules/@app/auth-sdk/package.json"),
			"utf8",
		),
	);
	assert.doesNotMatch(
		JSON.stringify(manifest),
		/workspace:|D:[\\/]|\.\.\/\.\.\/vendor/,
	);
	assert.deepEqual(manifest.peerDependenciesMeta["monitor-analytics-sdk"], {
		optional: true,
	});
	await writeFile(
		join(consumer, "verify.mjs"),
		String.raw`
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SourceTextModule,createContext} from 'node:vm';
import {betterAuth} from '@app/auth-sdk/server';
import {business} from '@app/auth-sdk/business';
import {admin} from '@app/auth-sdk/plugins';
import {credits} from '@app/auth-sdk/credits';
import {subscription,createProductService} from '@app/auth-sdk/subscription';
import {createMonitorOptions} from '@app/auth-sdk/monitor';
import {monitorHeaders} from '@app/auth-sdk/monitor/client';
const require=createRequire(import.meta.url);
assert.equal(typeof require('monitor-analytics-sdk/server').sendConfirmedPayment,'function');
const sdkRequire=createRequire(require.resolve('@app/auth-sdk/server'));
const {getMigrations}=await import(pathToFileURL(sdkRequire.resolve('better-auth/db/migration')).href);
const {createCollector}=await import(pathToFileURL(resolve(process.env.MONITOR_COLLECTOR_PATH,'src/server.ts')).href);
const {chromium}=require(process.env.MONITOR_PLAYWRIGHT_PATH);
const browserDist=dirname(fileURLToPath(import.meta.resolve('monitor-analytics-sdk')));
const web=createServer(async (request,response)=>{
 try {
  const pathname=new URL(request.url,'http://localhost').pathname;
  if (/^\/sdk\/(?:chunks\/)?[\w.-]+\.js$/.test(pathname)) {
   response.setHeader('Content-Type','text/javascript');
   response.end(await readFile(join(browserDist,pathname.slice('/sdk/'.length))));
  } else if (pathname==='/tools') {
   response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Monitor integration</title>');
  } else {response.writeHead(404);response.end()}
 } catch {response.writeHead(500);response.end()}
});
await new Promise((done,reject)=>{web.once('error',reject);web.listen(0,'127.0.0.1',done)});
const token=crypto.randomUUID(), readToken=crypto.randomUUID(), origin='http://127.0.0.1:'+web.address().port;
const collector=createCollector({databasePath:resolve('collector.sqlite'),sites:{'integration-site':{origins:[origin],allowedPaths:['/tools'],browserEvents:{integration_probe:[]}}}, credentials:[{token,siteIds:['integration-site'],eventTypes:{signup_confirmed:['method'],payment_confirmed:['amount','currency']}},{token:readToken,siteIds:['integration-site'],eventTypes:{},read:true}]});
const db=new DatabaseSync(resolve('business.sqlite'));
let browser;
try {
 await new Promise((done,reject)=>{collector.server.once('error',reject);collector.server.listen(0,'127.0.0.1',done)});
 const endpoint='http://127.0.0.1:'+collector.server.address().port;
 const env={APP_MONITOR_ENABLED:'true',APP_MONITOR_SITE_ID:'integration-site',APP_MONITOR_ENVIRONMENT:'development',APP_MONITOR_ENDPOINT:endpoint+'/v1/server-events',APP_MONITOR_TOKEN:token,APP_MONITOR_ORIGINS_JSON:JSON.stringify([origin]),APP_MONITOR_ALLOWED_PATHS_JSON:'["/tools"]'};
 const monitor=createMonitorOptions({env});
 const config={baseURL:origin,secret:crypto.randomUUID()+crypto.randomUUID(),database:db,emailAndPassword:{enabled:true},plugins:[admin({auditLog:true}),subscription({catalog:true}),credits(),business({monitor,providers:{test:{createCheckout:async order=>({providerOrderId:'remote-'+order.id,url:'https://pay.example/checkout'}),verifyPayment:async ({order})=>({providerOrderId:'remote-'+order.id,paymentId:'paid-'+order.id,amount:order.amount,currency:order.currency,paidAt:order.createdAt})}}})]};
 await (await getMigrations(config)).runMigrations();
 const auth=betterAuth(config);
 browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??(process.platform==='win32'?'chrome':undefined)});
 const page=await browser.newPage();
 await page.addInitScript(()=>{
  const getItem=Storage.prototype.getItem;
  Storage.prototype.getItem=function(key){
   if(key.startsWith('monitor:identity:'))throw new DOMException('Identity storage blocked','SecurityError');
   return getItem.call(this,key);
  };
 });
 await page.goto(origin+'/tools?utm_source=newsletter&email=private@example.test#token=private');
 const received=page.waitForResponse(endpoint+'/v1/browser-events');
 const clues=await page.evaluate(async endpoint=>{
  const {monitor}=await import('/sdk/index.js');
  monitor.init({siteId:'integration-site',environment:'development',collector:{endpoint:endpoint+'/v1/browser-events',events:{integration_probe:[]}},privacy:{allowedPaths:['/tools']},modules:{attribution:{persistence:'local',utmAllowlist:{utm_source:['newsletter']}},identity:{persistence:'local'}},consent:{collector:true,attribution:true,storage:true,identity:true}});
  await monitor.ready();monitor.track('integration_probe');await monitor.flush();
  return monitor.getAttributionContext();
 },endpoint);
 assert.equal((await received).status(),200);
 assert.match(clues.visitor_id,/^[0-9a-f-]{36}$/);
 assert.match(clues.session_id,/^[0-9a-f-]{36}$/);
 assert.equal(clues.attribution.first_touch.utm.utm_source,'newsletter');
 assert.doesNotMatch(JSON.stringify(clues),/private@example|token=private/);
 const signed=await auth.api.signUpEmail({body:{name:'Buyer',email:'buyer@example.test',password:'test-password-at-least-12'},headers:monitorHeaders(clues),returnHeaders:true});
 const headers=new Headers({cookie:signed.headers.get('set-cookie'),...monitorHeaders(clues)});
 const {adapter}=await auth.$context;
 const product=await createProductService(adapter).save({key:'credits',name:'Credits',type:'credits',credits:10,amount:990,currency:'USD',published:true,expectedVersion:0});
 const order=await auth.api.createBusinessOrder({headers,body:{productId:product.id,provider:'test',idempotencyKey:'purchase'}});
 await auth.api.checkoutBusinessOrder({headers,body:{orderId:order.id}});
 await Promise.all([auth.api.completeBusinessOrder({headers,body:{orderId:order.id}}),auth.api.confirmBusinessPayment({body:{orderId:order.id,reference:'remote-'+order.id}})]);
 // An independent database confirms actual server ingestion even when local ACK persistence fails.
 db.exec("CREATE TRIGGER lost_ack BEFORE UPDATE ON businessMonitorEvent WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'lost ack'); END");
 await assert.rejects(auth.api.runMonitorDelivery());
 assert.equal(await adapter.count({model:'businessMonitorEvent'}),2);
 db.exec('DROP TRIGGER lost_ack');
 await adapter.updateMany({model:'businessMonitorEvent',where:[],update:{leaseExpiresAt:new Date(0)}});
 const restarted=betterAuth(config);
 await restarted.api.runMonitorDelivery();
 assert.equal(await adapter.count({model:'businessMonitorEvent',where:[{field:'status',value:'sent'}]}),2);
 const response=await fetch(endpoint+'/v1/events?site_id=integration-site&limit=100',{headers:{authorization:'Bearer '+readToken}});
 assert.equal(response.status,200);
 const {events:allEvents}=await response.json();
 const events=allEvents.filter(row=>row.received_via==='server');
 assert.equal(allEvents.length,3);
 assert.equal(allEvents.find(row=>row.received_via==='browser').event.context.visitor_id,clues.visitor_id);
 assert.equal(events.length,2);
 assert.ok(events.every(row=>row.received_via==='server'));
 assert.ok(events.every(row=>row.event.context.visitor_id===clues.visitor_id&&row.event.context.session_id===clues.session_id));
 const payment=events.find(row=>row.event.event_type==='payment_confirmed').event;
 assert.deepEqual(payment.props,{amount:990,currency:'USD'});
 assert.deepEqual(payment.context.attribution,clues.attribution);
 assert.equal(payment.identity.user_id,signed.response.user.id);
 assert.equal(payment.identity.order_id,order.id);
 assert.equal(payment.occurred_at,order.createdAt.toISOString());
 assert.equal(new Set(events.map(row=>row.event.event_id)).size,2);
 // Evaluate the distributed server entry with Web APIs only: no process, Buffer, require or filesystem.
 const context=createContext({URL,TextEncoder,TextDecoder,AbortSignal,Response,structuredClone,fetch:async()=>Response.json({accepted:1,duplicates:0}),setInterval,clearInterval,console});
 const sender=new SourceTextModule(await readFile(new URL(import.meta.resolve('monitor-analytics-sdk/server')),'utf8'),{context});
 await sender.link(()=>{throw new Error('Unexpected runtime dependency')});await sender.evaluate();
 const bridge=new SourceTextModule(await readFile(require.resolve('@app/auth-sdk/monitor'),'utf8'),{context});
 await bridge.link(specifier=>{assert.equal(specifier,'monitor-analytics-sdk/server');return sender});await bridge.evaluate();
 assert.equal(bridge.namespace.createMonitorOptions(),undefined);
 const portable=bridge.namespace.createMonitorOptions({env});
 assert.equal((await portable.send({type:'payment_confirmed',record:{siteId:'integration-site',environment:'development',eventId:crypto.randomUUID(),occurredAt:new Date().toISOString(),userId:'user',orderId:'order',amount:990,currency:'USD',attribution:clues}})).accepted,1);
 console.log('Real browser, independent packages, Web API runtime, SQLite and real Collector: passed');
} finally {await browser?.close();collector.server.closeAllConnections();await collector.close();db.close();web.closeAllConnections();await new Promise((done,reject)=>web.close(error=>error?reject(error):done()))}
`,
	);
	const result = spawnSync(
		process.execPath,
		["--experimental-vm-modules", "verify.mjs"],
		{
			cwd: consumer,
			encoding: "utf8",
			timeout: 45_000,
			env: {
				...process.env,
				MONITOR_PLAYWRIGHT_PATH: createRequire(
					join(root, "apps/dashboard/package.json"),
				).resolve("@playwright/test"),
			},
		},
	);
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	t.diagnostic(result.stdout.trim());
});
