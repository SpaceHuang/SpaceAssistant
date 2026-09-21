async def job():
    async with open("f.txt") as fh:
        return fh.read()
