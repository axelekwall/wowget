@{
    Severity     = @('Error', 'Warning', 'Information')
    ExcludeRules = @(
        'PSUseShouldProcessForStateChangingFunctions'
        'PSUseSingularNouns'
        'PSAvoidUsingPositionalParameters'
        # Pester shares variables between BeforeAll, BeforeEach and It blocks, which the analyzer
        # sees as separate scopes, so it reports them as unused.
        'PSUseDeclaredVarsMoreThanAssignments'
        'PSReviewUnusedParameter'
    )
}
