Most marks are sourced from Lobe Icons 1.94.0 (MIT): https://github.com/lobehub/lobe-icons
`xiaomi-mimo.svg` is the XiaomiMiMo icon from Lobe Icons 1.95.1 (MIT), added 2026-09-30.
The Qianwen mark follows the current official mark displayed at https://create.qianwen.com/ (retrieved 2026-08-10).
`thinking-machines.png` is Thinking Machines Lab's own site icon, https://thinkingmachines.ai/images/apple-touch-icon.png (retrieved 2026-09-30, unmodified); the company publishes no other mark.

The filenames do not define product semantics. The mapping is in `packages/backend/src/leaderboard/registry.ts` (`FAMILY_MARKS`, then `PROVIDER_MARKS`; the provider comes from `providers.ts`): a model-family mark is resolved first and a genuine provider mark is used only as a fallback. In particular, Grok, Hunyuan, Qianwen, Claude, Gemini, Kimi and MiMo marks identify those model families rather than xAI, Tencent, Alibaba, Anthropic, Google, Moonshot AI or Xiaomi as companies.

The marks remain trademarks of their respective owners and are used only for identification.
