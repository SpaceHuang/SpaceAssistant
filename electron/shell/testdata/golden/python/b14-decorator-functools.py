import functools

@functools.wraps(print)
def wrapper(*a, **k):
    return print(*a, **k)
