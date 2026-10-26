/*
    happy-dom 的默认地址是 `http://localhost:3000/`；Wails runtime 在“浏览器环境”里会探测
    `/wails/custom.js`，RPC 也会 POST `/wails/runtime`。测试进程里没有后端，这两条都会变成
    ECONNREFUSED 并刷 stderr。

    测试是离线的：所有 fetch 直接拒绝。可选脚本探测自己会 catch，RPC 调用方照常收到错误。
*/
globalThis.fetch = (() =>
    Promise.reject(new Error("network is disabled in tests"))) as typeof fetch
