"""HS-inspired support shrinkage of fitted tree contributions, not response means."""
from __future__ import annotations
import copy
import math


def require(condition, message):
    if not condition:
        raise ValueError(message)


def hierarchical_values(values, counts, strength):
    require(math.isfinite(strength) and strength >= 0, 'nonnegative_finite_lambda_required')
    require(len(values) == len(counts) and len(values) > 0 and len(values) & (len(values) - 1) == 0,
            'power_of_two_leaf_arrays_required')
    require(all(math.isfinite(value) for value in values), 'nonfinite_original_leaf_value')
    require(all(math.isfinite(count) and count >= 0 for count in counts), 'invalid_original_leaf_support')
    require(sum(counts) > 0, 'positive_root_support_required')
    depth = len(values).bit_length() - 1
    levels = []
    for length in range(depth + 1):
        mask = (1 << length) - 1
        nodes = []
        for prefix in range(1 << length):
            indices = [leaf for leaf in range(len(values)) if leaf & mask == prefix]
            support = math.fsum(float(counts[leaf]) for leaf in indices)
            parent = prefix & ((1 << (length - 1)) - 1) if length else None
            mean = (math.fsum(values[leaf] * float(counts[leaf]) for leaf in indices) / support
                    if support else levels[-1][parent]['mean'])
            nodes.append({'prefix': prefix, 'support': support, 'mean': mean})
        levels.append(nodes)
    edited = []
    for leaf in range(len(values)):
        increments = [levels[0][0]['mean']]
        for length in range(1, depth + 1):
            child = levels[length][leaf & ((1 << length) - 1)]
            parent = levels[length - 1][leaf & ((1 << (length - 1)) - 1)]
            # A zero-support parent has only empty descendants, hence a zero increment.
            factor = parent['support'] / (parent['support'] + strength) if parent['support'] else 0.
            increments.append((child['mean'] - parent['mean']) * factor)
        edited.append(math.fsum(increments))
    original_mean = levels[0][0]['mean']
    edited_mean = math.fsum(value * float(count) for value, count in zip(edited, counts)) / sum(counts)
    error = abs(edited_mean - original_mean)
    require(error <= 1e-12, 'weighted_tree_mean_not_preserved')
    return edited, {'nodeLevels': levels, 'weightedMeanBefore': original_mean,
                    'weightedMeanAfter': edited_mean, 'weightedMeanMaximumError': error,
                    'changedLeafCount': sum(before != after for before, after in zip(values, edited))}


def shrink_model(model, strength):
    candidate = copy.deepcopy(model)
    trees = []
    for number, (original, edited) in enumerate(zip(model['oblivious_trees'], candidate['oblivious_trees'])):
        require(len(original['leaf_values']) == 1 << len(original.get('splits', [])), 'scalar_oblivious_tree_required')
        edited['leaf_values'], audit = hierarchical_values(original['leaf_values'], original['leaf_weights'], strength)
        require({key: value for key, value in original.items() if key != 'leaf_values'} ==
                {key: value for key, value in edited.items() if key != 'leaf_values'}, 'nonleaf_tree_mutation')
        trees.append({'tree': number, **audit})
    require({key: value for key, value in model.items() if key != 'oblivious_trees'} ==
            {key: value for key, value in candidate.items() if key != 'oblivious_trees'}, 'non_tree_model_mutation')
    return candidate, {'lambda': strength, 'trees': trees, 'treeCount': len(trees),
                       'onlyLeafValuesChanged': True, 'allOtherModelMetadataExactlyUnchanged': True,
                       'maximumWeightedTreeMeanError': max(tree['weightedMeanMaximumError'] for tree in trees)}
