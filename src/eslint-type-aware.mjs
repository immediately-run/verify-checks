// eslint-type-aware.mjs — the shared type-aware ESLint rule set (R3-1081;
// implementation_standards R17's mechanical half). Data only: a plain rules
// object, so verify-checks gains no ESLint dependency. Each consumer's
// eslint.config.mjs spreads it in a block whose `files` match the repo's
// tsconfig `include`, with the parser's projectService on — and no consumer
// spells a rule name.
//
// The set is exactly these three (adding one is a separate item):
//   no-floating-promises     — every promise names its rejection sink (R17);
//                              `void x()` is the house idiom for intentional
//                              fire-and-forget (ignoreVoid).
//   no-misused-promises      — covers `forEach(async …)`; attributes:false
//                              because React onClick={async …} is pervasive and
//                              its sink is the handler's own catch (R17 review
//                              still checks that).
//   switch-exhaustiveness-check — R-SDKS-2 requires a `default` arm on open
//                              error-code unions, so the rule must accept one;
//                              a closed internal union with `default` is not
//                              checked for missing members (Record<Union, …>
//                              stays the pattern there).
export const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: true, attributes: false } }],
  '@typescript-eslint/switch-exhaustiveness-check': [
    'error',
    { considerDefaultExhaustiveForUnions: true, allowDefaultCaseForExhaustiveSwitch: true, requireDefaultForNonUnion: true },
  ],
};
