"""Sales tax calculation by region."""
from .rates import table

def compute_tax(amount):
    return amount

class TaxError(Exception):
    pass
