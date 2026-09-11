Protocol declarations and codec from [OhMyPi](https://github.com/can1357/oh-my-pi/tree/3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec/packages/catalog/src/discovery), MIT licensed.

Upstream paths: `devin-proto.ts`, `protobuf.ts`. The only initial runtime adaptation replaces the pi-utils `isRecord` dependency with a local guard. Keep protocol field numbers intact when updating. Wire fixtures test stable field tags independently of the codec.

The surrounding adapter also adapts the same commit's `packages/ai/src/providers/devin.ts`, `packages/ai/src/usage/devin.ts`, `packages/catalog/src/wire/devin.ts`, and `packages/catalog/src/compat/rules/auth/devin.kdl`. The MIT notice in this directory accompanies those adapted portions as well. Repository lint may reformat these files; protocol field numbers must remain unchanged.
