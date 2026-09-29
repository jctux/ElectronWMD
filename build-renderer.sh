#!/bin/bash
set -e

if [ -d "renderer" ]; then
    echo "Renderer is present. It won't be rebuilt"
    exit
fi

cd webminidisc
# Some dependencies of webminidisc's dependencies are git packages, which --allow-git=root refuses
npm i --allow-git=all
PUBLIC_URL="sandbox://app/" npm run build

function build_encoder() {
    E="$(pwd)"
    cd "../encoders/$1"
    npm ci
    npm run package
    cp *.wme "$E/dist/encoders/"
    cd "$E"
}

build_encoder local
npm run postbuild-finalize-encoders

rm -rf ../renderer
cp -rv dist ../renderer
cd ..

