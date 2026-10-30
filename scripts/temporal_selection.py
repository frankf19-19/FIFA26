"""Select using past rows only; never receive holdout labels in the scorer."""


def choose_on_training(candidates, rows, cutoff, evaluate):
    past = [row for row in rows if row[0] <= cutoff]
    if not past:
        raise ValueError('No training observations')
    def objective(candidate):
        values = evaluate(candidate, past)
        if len(values) != len(past):
            raise ValueError('Candidate must score the same training observations')
        return sum(values) / len(values)
    return max(candidates, key=objective)
