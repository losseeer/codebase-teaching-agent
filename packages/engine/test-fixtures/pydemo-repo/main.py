import app.store as store
from app.service import run
from app.rel import load_relative


def main() -> None:
    run()
    store.load()
    load_relative()


if __name__ == "__main__":
    main()
